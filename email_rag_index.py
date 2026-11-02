"""Pipeline di indicizzazione RAG delle email (solo locale, solo CPU).

Legge email_cache.json in sola lettura, pulisce i testi, li spezza in chunk e salva
embedding e metadati in email_rag.db (SQLite + FTS5).

Uso: python email_rag_index.py [--rebuild] [--limit N]
"""
import argparse
import datetime
import gc
import hashlib
import html
import json
import os
import re
import sqlite3
import sys
import time
from email.utils import parseaddr

import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('RAG_DB_PATH', os.path.join(BASE_DIR, 'email_rag.db'))
EMAIL_CACHE_PATH = os.environ.get('RAG_EMAIL_CACHE_PATH', os.path.join(BASE_DIR, 'email_cache.json'))
EMBED_MODEL_DIR = os.environ.get('RAG_EMBED_MODEL_DIR', os.path.join(BASE_DIR, 'models', 'rag', 'multilingual-e5-small'))
EMBED_MODEL_ID = 'multilingual-e5-small-q8'
EMBED_THREADS = int(os.environ.get('RAG_EMBED_THREADS', 2))

# La cache email vive 7 giorni: l'indice ha una retention propria, altrimenti non ci sarebbe storico.
RETENTION_DAYS = int(os.environ.get('RAG_RETENTION_DAYS', 90))
# Un'email piu' recente di questa soglia e assente dalla cache e' stata cancellata, non potata.
CACHE_RECENT_DAYS = 6
CHUNK_SIZE = 900
CHUNK_OVERLAP = 120
EMBED_BATCH_EMAILS = 64
SKIP_LABELS = {'SPAM', 'TRASH', 'DRAFT'}

DAY_MS = 24 * 60 * 60 * 1000

_FLAGS = re.IGNORECASE | re.MULTILINE
# Da qui in poi il testo e' la cronologia della conversazione: e' gia' indicizzata nelle email originali.
QUOTE_MARKERS = [
    re.compile(r'^\s*Il\s[^\n]{0,200}(?:\n[^\n]{0,120})?\sha scritto:\s*$', _FLAGS),
    re.compile(r'^\s*On\s[^\n]{0,200}(?:\n[^\n]{0,120})?\swrote:\s*$', _FLAGS),
    re.compile(r'^\s*-{2,}\s*(?:Original Message|Messaggio originale|Forwarded message|Messaggio inoltrato)', _FLAGS),
    re.compile(r'^\s*(?:Da|From)\s*:[^\n]*\n(?:[^\n]*\n){0,3}?\s*(?:Inviato|Data|Sent|Date)\s*:', _FLAGS),
]
SIGNATURE_MARKERS = [
    re.compile(r'^--\s*$', _FLAGS),
    re.compile(r'^\s*(?:Inviato da|Sent from)\s+(?:il mio |my )?\S+', _FLAGS),
    re.compile(r'^[^\n]*(?:Questo messaggio|Il presente messaggio|Le informazioni contenute)[^\n]{0,160}(?:riservat|confidenzial)', _FLAGS),
    re.compile(r'^[^\n]*(?:This e-?mail|This message)[^\n]{0,160}confidential', _FLAGS),
    re.compile(r'^[^\n]*ai sensi (?:del|dell.)\s*(?:D\.?\s?Lgs|GDPR|Regolamento|art)', _FLAGS),
]
# Sotto questa lunghezza il taglio ha tolto tutto (es. inoltro senza commento): si tiene il testo intero.
MIN_CLEAN_LENGTH = 40


def strip_html(text):
    text = re.sub(r'(?is)<(script|style|head)\b.*?</\1\s*>', ' ', text)
    text = re.sub(r'(?i)<br\s*/?>|</(?:p|div|tr|li|h[1-6])\s*>', '\n', text)
    text = re.sub(r'(?s)<[^>]{1,2000}>', ' ', text)
    return html.unescape(text)


def _cut_at_first_marker(text, markers):
    positions = [m.start() for m in (rx.search(text) for rx in markers) if m]
    return text[:min(positions)] if positions else text


def clean_email_body(body, body_html='', snippet=''):
    """Restituisce il solo testo scritto dal mittente, senza HTML, citazioni e firme."""
    text = body or ''
    if not text.strip():
        text = body_html or snippet or ''
    if re.search(r'</?[a-z][a-z0-9]*\b[^>]*>', text, re.IGNORECASE):
        text = strip_html(text)
    text = html.unescape(text).replace('\r\n', '\n').replace('\r', '\n').replace(' ', ' ')
    text = re.sub(r'\[(?:image|cid|immagine):[^\]]*\]', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'https?://\S{60,}', '[link]', text)
    text = re.sub(r'[A-Za-z0-9+/=]{120,}', ' ', text)

    full_text = '\n'.join(l for l in text.split('\n') if not l.lstrip().startswith('>'))
    trimmed = _cut_at_first_marker(full_text, QUOTE_MARKERS + SIGNATURE_MARKERS)
    if len(trimmed.strip()) < MIN_CLEAN_LENGTH:
        trimmed = _cut_at_first_marker(full_text, SIGNATURE_MARKERS)
    if len(trimmed.strip()) < MIN_CLEAN_LENGTH:
        trimmed = full_text

    trimmed = re.sub(r'[ \t]+', ' ', trimmed)
    trimmed = re.sub(r' ?\n ?', '\n', trimmed)
    return re.sub(r'\n{3,}', '\n\n', trimmed).strip()


def _split_long_block(block, size):
    pieces, current = [], ''
    for sentence in re.split(r'(?<=[.!?;:])\s+|\n', block):
        while len(sentence) > size:
            cut = sentence.rfind(' ', 0, size)
            cut = cut if cut > 0 else size
            pieces.append((current + ' ' + sentence[:cut]).strip() if current else sentence[:cut])
            current, sentence = '', sentence[cut:].strip()
        if len(current) + len(sentence) + 1 > size and current:
            pieces.append(current)
            current = sentence
        else:
            current = (current + ' ' + sentence).strip()
    if current:
        pieces.append(current)
    return pieces


def chunk_text(text, size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Chunk che rispettano paragrafi e frasi, con sovrapposizione per non perdere il contesto ai bordi."""
    if not text:
        return []
    blocks = []
    for paragraph in re.split(r'\n{2,}', text):
        paragraph = paragraph.strip()
        if paragraph:
            blocks.extend(_split_long_block(paragraph, size - overlap) if len(paragraph) > size - overlap else [paragraph])

    chunks, current = [], ''
    for block in blocks:
        if current and len(current) + len(block) + 2 > size:
            chunks.append(current)
            tail = current[-overlap:]
            tail = tail[tail.find(' ') + 1:] if ' ' in tail else ''
            current = f'{tail} {block}'.strip() if len(tail) + len(block) + 1 <= size else block
        else:
            current = f'{current}\n\n{block}' if current else block
    if current:
        chunks.append(current)
    return chunks


def prepare_email(email):
    """Da record della cache a metadati + chunk. Tutto cio' che non serve (bodyHtml, immagini) viene scartato."""
    subject = (email.get('subject') or '').strip() or '(senza oggetto)'
    name, address = parseaddr(email.get('from') or '')
    text = clean_email_body(email.get('body'), email.get('bodyHtml'), email.get('snippet'))
    try:
        date_ms = int(email.get('internalDate') or 0)
    except (TypeError, ValueError):
        date_ms = 0

    sender = f'{name} <{address}>' if name and address else (address or name or 'sconosciuto')
    chunks = []
    for seq, chunk in enumerate(chunk_text(text) or [subject]):
        # La data non entra nell'embedding: serve come filtro, e cosi' gli alert identici riusano lo stesso vettore.
        embed_text = f'passage: Oggetto: {subject}\nDa: {name or address}\n\n{chunk}'
        normalized = re.sub(r'\s+', ' ', re.sub(r'\d+', '#', f'{subject} {chunk}'.lower()))
        chunks.append({
            'seq': seq,
            'text': chunk,
            'embed_text': embed_text,
            'embed_hash': hashlib.sha1(embed_text.encode('utf-8')).hexdigest(),
            'dedup_key': hashlib.sha1(normalized.encode('utf-8')).hexdigest(),
        })

    return {
        'id': email['id'],
        'thread_id': email.get('threadId') or '',
        'subject': subject,
        'sender': sender,
        'sender_email': address.lower(),
        'recipients': ', '.join(filter(None, [email.get('to'), email.get('cc')])),
        'date_ms': date_ms,
        'category': email.get('category') or '',
        'content_hash': hashlib.sha1(f'{subject}\0{sender}\0{text}'.encode('utf-8')).hexdigest(),
        'chunks': chunks,
    }


class OnnxEmbedder:
    """multilingual-e5-small quantizzato: circa 120 MB su disco, nessuna dipendenza da torch."""

    def __init__(self, model_dir=EMBED_MODEL_DIR, threads=EMBED_THREADS):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.enable_cpu_mem_arena = False
        # Il modello si carica solo dal disco locale: a runtime nessuna chiamata verso Hugging Face.
        self.session = ort.InferenceSession(
            os.path.join(model_dir, 'onnx', 'model_quantized.onnx'), options, providers=['CPUExecutionProvider'])
        self.input_names = {i.name for i in self.session.get_inputs()}
        self.tokenizer = Tokenizer.from_file(os.path.join(model_dir, 'tokenizer.json'))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding()

    def _encode(self, texts):
        encoded = self.tokenizer.encode_batch(texts)
        ids = np.array([e.ids for e in encoded], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encoded], dtype=np.int64)
        feed = {'input_ids': ids, 'attention_mask': mask}
        if 'token_type_ids' in self.input_names:
            feed['token_type_ids'] = np.zeros_like(ids)
        hidden = self.session.run(None, feed)[0]
        weights = mask[..., None].astype(np.float32)
        vectors = (hidden * weights).sum(axis=1) / np.clip(weights.sum(axis=1), 1e-9, None)
        return (vectors / np.clip(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-9, None)).astype(np.float32)

    def embed_passages(self, texts, batch_size=16):
        # Ordinare per lunghezza riduce il padding, e con esso tempo e memoria.
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        result = [None] * len(texts)
        for start in range(0, len(order), batch_size):
            batch = order[start:start + batch_size]
            for index, vector in zip(batch, self._encode([texts[i] for i in batch])):
                result[index] = vector
        return result

    def embed_query(self, text):
        return self._encode([f'query: {text}'])[0]


def open_db(path=DB_PATH):
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=NORMAL')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS emails (
            id TEXT PRIMARY KEY,
            thread_id TEXT,
            subject TEXT,
            sender TEXT,
            sender_email TEXT,
            recipients TEXT,
            date_ms INTEGER,
            category TEXT,
            content_hash TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date_ms);
        CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(sender_email);
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY,
            email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
            seq INTEGER,
            text TEXT,
            embed_hash TEXT,
            dedup_key TEXT,
            vector BLOB
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_email ON chunks(email_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(embed_hash);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            subject, sender, text, tokenize="unicode61 remove_diacritics 2"
        );
    ''')
    return conn


def get_meta(conn, key, default=None):
    row = conn.execute('SELECT value FROM meta WHERE key = ?', (key,)).fetchone()
    return row['value'] if row else default


def set_meta(conn, key, value):
    conn.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', (key, str(value)))


def delete_emails(conn, email_ids):
    for email_id in email_ids:
        conn.execute('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE email_id = ?)', (email_id,))
        conn.execute('DELETE FROM emails WHERE id = ?', (email_id,))


def store_emails(conn, prepared, embedder):
    """Salva un gruppo di email. Il vettore viene ricalcolato solo per i testi mai visti."""
    all_chunks = [c for email in prepared for c in email['chunks']]
    known = {}
    hashes = list({c['embed_hash'] for c in all_chunks})
    for start in range(0, len(hashes), 500):
        part = hashes[start:start + 500]
        marks = ','.join('?' * len(part))
        for row in conn.execute(f'SELECT embed_hash, vector FROM chunks WHERE embed_hash IN ({marks}) GROUP BY embed_hash', part):
            known[row['embed_hash']] = row['vector']

    missing = {}
    for chunk in all_chunks:
        if chunk['embed_hash'] not in known:
            missing.setdefault(chunk['embed_hash'], chunk['embed_text'])
    if missing:
        vectors = embedder.embed_passages(list(missing.values()))
        for embed_hash, vector in zip(missing.keys(), vectors):
            known[embed_hash] = np.asarray(vector, dtype=np.float32).tobytes()

    delete_emails(conn, [email['id'] for email in prepared])
    for email in prepared:
        conn.execute(
            'INSERT INTO emails (id, thread_id, subject, sender, sender_email, recipients, date_ms, category, content_hash) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (email['id'], email['thread_id'], email['subject'], email['sender'], email['sender_email'],
             email['recipients'], email['date_ms'], email['category'], email['content_hash']))
        for chunk in email['chunks']:
            cursor = conn.execute(
                'INSERT INTO chunks (email_id, seq, text, embed_hash, dedup_key, vector) VALUES (?, ?, ?, ?, ?, ?)',
                (email['id'], chunk['seq'], chunk['text'], chunk['embed_hash'], chunk['dedup_key'], known[chunk['embed_hash']]))
            conn.execute('INSERT INTO chunks_fts (rowid, subject, sender, text) VALUES (?, ?, ?, ?)',
                         (cursor.lastrowid, email['subject'], email['sender'], chunk['text']))
    return len(missing)


def load_email_cache(path=EMAIL_CACHE_PATH, attempts=5):
    """Node riscrive la cache con un rename: su Windows il file puo' risultare occupato per qualche istante."""
    for attempt in range(attempts):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (PermissionError, json.JSONDecodeError):
            if attempt == attempts - 1:
                raise
            time.sleep(2 * (attempt + 1))


def reconcile_deleted(conn, cache_ids, now_ms):
    """Toglie dall'indice le email recenti sparite dalla cache, cioe' cancellate dagli utenti.

    Se ne sparisce piu' della meta' si sospetta una cache corrotta o ripristinata e non si tocca nulla.
    """
    threshold = now_ms - CACHE_RECENT_DAYS * DAY_MS
    recent = [r['id'] for r in conn.execute('SELECT id FROM emails WHERE date_ms >= ?', (threshold,))]
    missing = [email_id for email_id in recent if email_id not in cache_ids]
    if recent and len(missing) > len(recent) / 2:
        print(f'ATTENZIONE: {len(missing)}/{len(recent)} email recenti assenti dalla cache, riconciliazione saltata.')
        return 0
    delete_emails(conn, missing)
    return len(missing)


def sync_index(conn, cache, embedder, retention_days=RETENTION_DAYS, now_ms=None, limit=None, log=print):
    now_ms = now_ms or int(time.time() * 1000)
    oldest_allowed = now_ms - retention_days * DAY_MS
    existing = {r['id']: (r['content_hash'], r['category']) for r in conn.execute('SELECT id, content_hash, category FROM emails')}

    stats = {'indexed': 0, 'unchanged': 0, 'removed': 0, 'embedded_chunks': 0}
    pending, excluded = [], []
    for email in cache.values():
        if not email.get('id'):
            continue
        if SKIP_LABELS.intersection(email.get('labelIds') or []):
            excluded.append(email['id'])
            continue
        prepared = prepare_email(email)
        if prepared['date_ms'] and prepared['date_ms'] < oldest_allowed:
            continue
        previous = existing.get(prepared['id'])
        if previous and previous[0] == prepared['content_hash']:
            stats['unchanged'] += 1
            if previous[1] != prepared['category']:
                conn.execute('UPDATE emails SET category = ? WHERE id = ?', (prepared['category'], prepared['id']))
            continue
        pending.append(prepared)
        if limit and len(pending) >= limit:
            break

    # I piu' recenti per primi, e commit a ogni gruppo: un'interruzione non fa perdere il lavoro gia' fatto.
    pending.sort(key=lambda e: e['date_ms'], reverse=True)
    started = time.time()
    for start in range(0, len(pending), EMBED_BATCH_EMAILS):
        batch = pending[start:start + EMBED_BATCH_EMAILS]
        stats['embedded_chunks'] += store_emails(conn, batch, embedder)
        stats['indexed'] += len(batch)
        conn.commit()
        log(f'  {stats["indexed"]}/{len(pending)} email, {stats["embedded_chunks"]} chunk nuovi, {time.time() - started:.0f}s')

    removable = [email_id for email_id in excluded if email_id in existing]
    delete_emails(conn, removable)
    stats['removed'] += len(removable)
    if not limit:
        stats['removed'] += reconcile_deleted(conn, set(cache.keys()), now_ms)

    expired = [r['id'] for r in conn.execute('SELECT id FROM emails WHERE date_ms > 0 AND date_ms < ?', (oldest_allowed,))]
    delete_emails(conn, expired)
    stats['removed'] += len(expired)

    if stats['indexed'] or stats['removed']:
        # Il server di query ricarica la matrice dei vettori solo quando la generazione cambia.
        # Un timestamp, non un contatore: dopo un --rebuild il contatore ripartirebbe da valori gia' visti.
        set_meta(conn, 'generation', time.time_ns())
    set_meta(conn, 'last_sync', datetime.datetime.now().isoformat(timespec='seconds'))
    conn.commit()
    return stats


def check_embed_model(conn, model_id=EMBED_MODEL_ID):
    current = get_meta(conn, 'embed_model')
    if current and current != model_id:
        raise SystemExit(f'Indice creato con {current}, configurato {model_id}: rilancia con --rebuild.')
    set_meta(conn, 'embed_model', model_id)
    conn.commit()


def main():
    parser = argparse.ArgumentParser(description='Indicizza le email per il RAG locale')
    parser.add_argument('--rebuild', action='store_true', help="ricrea l'indice da zero (lo storico fuori dalla cache va perso)")
    parser.add_argument('--limit', type=int, help='indicizza al massimo N email nuove, per le prove')
    args = parser.parse_args()

    conn = open_db()
    if args.rebuild:
        conn.executescript('DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM emails; DELETE FROM meta;')
    check_embed_model(conn)

    cache = load_email_cache()
    # Il sync e' un processo a vita breve: la memoria del JSON da 160 MB torna al sistema alla sua uscita.
    print(f'{len(cache)} email in cache')
    stats = sync_index(conn, cache, OnnxEmbedder(), limit=args.limit)
    del cache
    gc.collect()
    print(json.dumps(stats))
    conn.close()


if __name__ == '__main__':
    sys.exit(main())
