"""Servizio HTTP dell'assistente email. Ascolta solo su 127.0.0.1: l'autenticazione e' nel proxy di index.js."""
import json
import os
import subprocess
import sys
import threading
import time
import traceback

from flask import Flask, Response, jsonify, request

from email_rag_index import DB_PATH, EMAIL_CACHE_PATH, OnnxEmbedder, check_embed_model, get_meta, open_db
from email_rag_query import LLM_URL, VectorIndex, ask, ask_stream, assert_local_url

SYNC_MINUTES = int(os.environ.get('RAG_SYNC_MINUTES', 10))
MAX_QUESTION_LENGTH = 500
# Una sola generazione alla volta: una seconda su CPU rallenterebbe entrambe. Meglio dire "occupato".
LLM_QUEUE_WAIT_SECONDS = 2

app = Flask(__name__)
llm_slot = threading.Semaphore(1)
vector_index = VectorIndex()
embedder = None
embedder_lock = threading.Lock()
sync_process = None
sync_lock = threading.Lock()
last_synced_mtime = None


def get_embedder():
    global embedder
    with embedder_lock:
        if embedder is None:
            embedder = OnnxEmbedder()
        return embedder


def start_sync():
    """Il sync gira in un processo separato e a bassa priorita', per non togliere CPU a Node e ai classificatori."""
    global sync_process, last_synced_mtime
    with sync_lock:
        if sync_process is not None and sync_process.poll() is None:
            return False
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'email_rag_index.py')
        flags = subprocess.BELOW_NORMAL_PRIORITY_CLASS if sys.platform == 'win32' else 0
        if os.path.exists(EMAIL_CACHE_PATH):
            last_synced_mtime = os.path.getmtime(EMAIL_CACHE_PATH)
        sync_process = subprocess.Popen([sys.executable, script], creationflags=flags)
        return True


def warm_up():
    """Carica embedder e vettori subito, cosi' la prima domanda non aspetta qualche secondo in piu'."""
    try:
        get_embedder()
        conn = open_db()
        try:
            vector_index.refresh(conn)
        finally:
            conn.close()
    except Exception:
        traceback.print_exc()


def sync_scheduler():
    while True:
        time.sleep(SYNC_MINUTES * 60)
        try:
            if os.path.exists(EMAIL_CACHE_PATH) and os.path.getmtime(EMAIL_CACHE_PATH) != last_synced_mtime:
                start_sync()
        except Exception:
            traceback.print_exc()


@app.route('/api/assistant/ask', methods=['POST'])
def assistant_ask():
    data = request.get_json(silent=True) or {}
    question = (data.get('question') or '').strip()
    if not question:
        return jsonify({'message': 'Domanda mancante.'}), 400
    if len(question) > MAX_QUESTION_LENGTH:
        return jsonify({'message': f'Domanda troppo lunga (massimo {MAX_QUESTION_LENGTH} caratteri).'}), 400

    if not llm_slot.acquire(timeout=LLM_QUEUE_WAIT_SECONDS):
        return jsonify({'message': "L'assistente sta gia' rispondendo a un'altra domanda. Riprova tra poco."}), 429
    conn = open_db()
    try:
        filters = {key: data.get(key) for key in ('date_from', 'date_to', 'sender', 'category', 'thread_id')}
        return jsonify(ask(conn, vector_index, get_embedder(), question, filters))
    except Exception:
        traceback.print_exc()
        return jsonify({'message': "Errore interno dell'assistente."}), 500
    finally:
        conn.close()
        llm_slot.release()


@app.route('/api/assistant/ask-stream', methods=['POST'])
def assistant_ask_stream():
    data = request.get_json(silent=True) or {}
    question = (data.get('question') or '').strip()
    if not question:
        return jsonify({'message': 'Domanda mancante.'}), 400
    if len(question) > MAX_QUESTION_LENGTH:
        return jsonify({'message': f'Domanda troppo lunga (massimo {MAX_QUESTION_LENGTH} caratteri).'}), 400
    if not llm_slot.acquire(timeout=LLM_QUEUE_WAIT_SECONDS):
        return jsonify({'message': "L'assistente sta gia' rispondendo a un'altra domanda. Riprova tra poco."}), 429

    filters = {key: data.get(key) for key in ('date_from', 'date_to', 'sender', 'category', 'thread_id')}

    def generate():
        conn = open_db()
        try:
            for event in ask_stream(conn, vector_index, get_embedder(), question, filters):
                yield json.dumps(event, ensure_ascii=False) + '\n'
        except Exception:
            traceback.print_exc()
            yield json.dumps({'type': 'error', 'message': "Errore interno dell'assistente."}, ensure_ascii=False) + '\n'
        finally:
            conn.close()

    response = Response(generate(), mimetype='application/x-ndjson', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
    # Non nel generatore: se il client sparisce prima del primo evento, il suo finally non verrebbe mai eseguito.
    response.call_on_close(llm_slot.release)
    return response


@app.route('/api/assistant/sync', methods=['POST'])
def assistant_sync():
    return jsonify({'started': start_sync()})


@app.route('/api/assistant/status', methods=['GET'])
def assistant_status():
    conn = open_db()
    try:
        return jsonify({
            'emails': conn.execute('SELECT COUNT(*) AS n FROM emails').fetchone()['n'],
            'chunks': conn.execute('SELECT COUNT(*) AS n FROM chunks').fetchone()['n'],
            'last_sync': get_meta(conn, 'last_sync'),
            'embed_model': get_meta(conn, 'embed_model'),
            'sync_running': sync_process is not None and sync_process.poll() is None,
        })
    finally:
        conn.close()


if __name__ == '__main__':
    assert_local_url(LLM_URL)
    bootstrap = open_db(DB_PATH)
    check_embed_model(bootstrap)
    bootstrap.close()
    threading.Thread(target=warm_up, daemon=True).start()
    threading.Thread(target=sync_scheduler, daemon=True).start()
    app.run(host='127.0.0.1', port=int(os.environ.get('RAG_PORT', 5009)), debug=False, threaded=True)
