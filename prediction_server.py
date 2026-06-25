import json
import threading
import subprocess
from flask import Flask, request, jsonify
from flask_cors import CORS
from transformers import (
    pipeline,
    BitsAndBytesConfig,
    AutoModelForCausalLM,
    AutoTokenizer,
    AutoModel,
    RobertaForSequenceClassification,
)
from transformers.utils import is_bitsandbytes_available
import torch
import sqlite3
import numpy as np
import os
import re
import csv
import traceback
import platform
import pandas as pd
import logging
from logging.handlers import RotatingFileHandler

import ssl

def clean_html(text):
    if pd.isna(text) or text == '1': # Handle NaN and '1' as empty body
        return ""
    # Remove HTML tags
    clean = re.compile('<.*?>')
    text = re.sub(clean, '', text)
    # Remove newlines and extra spaces
    text = text.replace('\n', ' ').replace('\r', '')
    text = re.sub(' +', ' ', text).strip() # Replace multiple spaces with single space
    return text

app = Flask(__name__)
CORS(app)

# Global lock for thread-safe model inference
classification_lock = threading.Lock()


# Logging configuration
log_dir = 'logs/prediction_server'
os.makedirs(log_dir, exist_ok=True)
error_log_file = f'{log_dir}/error.log'
combined_log_file = f'{log_dir}/combined.log'

# Error logger
error_handler = RotatingFileHandler(error_log_file, maxBytes=10000, backupCount=1)
error_handler.setLevel(logging.ERROR)
error_formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
error_handler.setFormatter(error_formatter)
app.logger.addHandler(error_handler)

# Combined logger
combined_handler = RotatingFileHandler(combined_log_file, maxBytes=10000, backupCount=1)
combined_handler.setLevel(logging.INFO)
combined_formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
combined_handler.setFormatter(combined_formatter)
app.logger.addHandler(combined_handler)

# Set the app logger level
app.logger.setLevel(logging.INFO)


# Importance Scoring Model has been moved to Gemini on the frontend/node side.
# Local classification is now only for Human/Bot.

# -----------------------------
# Bot/Human Classification Model
# -----------------------------
bot_human_model_path = "fine_tuned_llm_model_bot_human"
if os.path.exists(bot_human_model_path) and os.listdir(bot_human_model_path):
    app.logger.info(f"Loading bot/human model from {bot_human_model_path}...")
    bot_human_classifier = pipeline("text-classification", model=bot_human_model_path)
else:
    app.logger.warning("Bot/human model not found. Loading base model...")
    bot_human_classifier = pipeline("zero-shot-classification", model="valhalla/distilbart-mnli-12-3")

app.logger.info("Models loaded.")

# -----------------------------
# SmartSupport Knowledge Base (SQLite + all-MiniLM-L6-v2)
# -----------------------------
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'smartsupport.db')

class DatabaseManager:
    def __init__(self):
        self.vss_loaded = False
        self.conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_db()

    def _init_db(self):
        cursor = self.conn.cursor()
        
        # Tentativo caricamento sqlite-vss
        try:
            import sqlite_vss
            self.conn.enable_load_extension(True)
            sqlite_vss.load(self.conn)
            self.conn.enable_load_extension(False)
            self.vss_loaded = True
            app.logger.info("sqlite-vss caricato con successo.")
        except Exception as e:
            app.logger.warning(f"Impossibile caricare sqlite-vss ({e}). Verrà utilizzato il fallback standard con calcolo coseno in Python.")

        # Tabella standard dei ticket
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY,
                cliente TEXT,
                operatore TEXT,
                subject TEXT,
                description TEXT,
                solution TEXT,
                vector TEXT, -- Vettore memorizzato come stringa JSON di float
                closed_on TEXT
            )
        ''')
        
        if self.vss_loaded:
            try:
                cursor.execute('''
                    CREATE VIRTUAL TABLE IF NOT EXISTS vss_tickets USING vss0(
                        vector(384)
                    )
                ''')
                cursor.execute('''
                    CREATE TABLE IF NOT EXISTS vss_map (
                        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                        ticket_id INTEGER UNIQUE
                    )
                ''')
            except Exception as e:
                app.logger.error(f"Errore creazione tabelle virtuali VSS ({e}). Fallback su ricerca standard.")
                self.vss_loaded = False
                
        self.conn.commit()

    def save_ticket(self, ticket_id, cliente, operatore, subject, description, solution, vector, closed_on=None):
        cursor = self.conn.cursor()
        vector_str = json.dumps(vector)
        
        # Inserimento o sostituzione nella tabella standard
        cursor.execute('''
            INSERT OR REPLACE INTO tickets (id, cliente, operatore, subject, description, solution, vector, closed_on)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (ticket_id, cliente, operatore, subject, description, solution, vector_str, closed_on))
        
        if self.vss_loaded:
            try:
                cursor.execute('INSERT OR IGNORE INTO vss_map (ticket_id) VALUES (?)', (ticket_id,))
                cursor.execute('SELECT rowid FROM vss_map WHERE ticket_id = ?', (ticket_id,))
                row = cursor.fetchone()
                if row:
                    rowid = row[0]
                    cursor.execute('INSERT OR REPLACE INTO vss_tickets(rowid, vector) VALUES (?, ?)', (rowid, vector_str))
            except Exception as e:
                app.logger.error(f"Errore salvataggio VSS per ticket #{ticket_id}: {e}")
                
        self.conn.commit()

    def search_similar(self, cliente, query_vector, limit=5):
        cursor = self.conn.cursor()
        
        # Filtriamo per lo stesso cliente se fornito, altrimenti tutti
        if cliente:
            cursor.execute('''
                SELECT id, cliente, operatore, subject, description, solution, vector, closed_on 
                FROM tickets 
                WHERE LOWER(cliente) = LOWER(?)
            ''', (cliente,))
        else:
            cursor.execute('''
                SELECT id, cliente, operatore, subject, description, solution, vector, closed_on 
                FROM tickets 
            ''')
        
        rows = cursor.fetchall()
        if not rows:
            return []

        q_vec = np.array(query_vector, dtype=np.float32)
        q_norm = np.linalg.norm(q_vec)
        
        vectors = []
        valid_rows = []
        for row in rows:
            if not row['vector']:
                continue
            try:
                vectors.append(json.loads(row['vector']))
                valid_rows.append(row)
            except Exception as e:
                app.logger.error(f"Errore caricamento vettore per ticket #{row['id']}: {e}")
        
        if not vectors:
            return []
            
        matrix = np.array(vectors, dtype=np.float32)
        row_norms = np.linalg.norm(matrix, axis=1)
        dot_products = np.dot(matrix, q_vec)
        
        similarities = np.zeros(len(valid_rows), dtype=np.float32)
        nonzero = (row_norms > 0) & (q_norm > 0)
        similarities[nonzero] = dot_products[nonzero] / (row_norms[nonzero] * q_norm)
        
        results = []
        for i, row in enumerate(valid_rows):
            results.append({
                'id': row['id'],
                'cliente': row['cliente'],
                'operatore': row['operatore'],
                'subject': row['subject'],
                'description': row['description'],
                'solution': row['solution'],
                'similarity': float(similarities[i]),
                'closed_on': row['closed_on']
            })
            
        results.sort(key=lambda x: x['similarity'], reverse=True)
        return results[:limit]

db_mgr = DatabaseManager()

# Modello di embedding
embedding_tokenizer = None
embedding_model = None
embedding_lock = threading.Lock()

def load_embedding_model():
    global embedding_tokenizer, embedding_model
    try:
        app.logger.info("Caricamento del modello di embedding all-MiniLM-L6-v2...")
        embedding_tokenizer = AutoTokenizer.from_pretrained("sentence-transformers/all-MiniLM-L6-v2")
        embedding_model = AutoModel.from_pretrained("sentence-transformers/all-MiniLM-L6-v2")
        embedding_model.eval()
        app.logger.info("Modello all-MiniLM-L6-v2 caricato con successo.")
    except Exception as e:
        app.logger.error(f"Errore caricamento modello di embedding: {e}")

def get_text_embedding(text):
    global embedding_tokenizer, embedding_model
    if embedding_tokenizer is None or embedding_model is None:
        with embedding_lock:
            if embedding_tokenizer is None or embedding_model is None:
                load_embedding_model()
                
    # Tokenizzazione ed elaborazione
    inputs = embedding_tokenizer(text, padding=True, truncation=True, max_length=512, return_tensors="pt")
    with torch.no_grad():
        outputs = embedding_model(**inputs)
    
    # Mean pooling
    token_embeddings = outputs[0]
    attention_mask = inputs['attention_mask']
    input_mask_expanded = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
    sum_embeddings = torch.sum(token_embeddings * input_mask_expanded, 1)
    sum_mask = torch.clamp(input_mask_expanded.sum(1), min=1e-9)
    embedding = sum_embeddings / sum_mask
    
    # Normalizzazione L2
    embedding = torch.nn.functional.normalize(embedding, p=2, dim=1)
    return embedding[0].tolist()


# Endpoint per l'indicizzazione dei ticket
@app.route('/api/smartsupport/index-ticket', methods=['POST'])
def index_ticket():
    try:
        data = request.get_json()
        if not data or 'id' not in data or 'subject' not in data:
            return jsonify({'error': 'Dati del ticket mancanti o errati.'}), 400
            
        ticket_id = int(data['id'])
        cliente = data.get('cliente', '')
        operatore = data.get('operatore', '') or 'Nessuno'
        subject = data.get('subject', '')
        description = data.get('description', '') or ''
        solution = data.get('solution', '') or ''
        closed_on = data.get('closed_on', '')
        
        # Testo completo per l'embedding
        text_to_embed = f"{subject}\n{description}\n{solution}"
        
        # Calcolo embedding
        vector = get_text_embedding(text_to_embed)
        
        # Salvataggio
        db_mgr.save_ticket(ticket_id, cliente, operatore, subject, description, solution, vector, closed_on)
        
        app.logger.info(f"Ticket #{ticket_id} indicizzato per il cliente '{cliente}'.")
        return jsonify({'success': True, 'message': f'Ticket #{ticket_id} indicizzato con successo.'})
    except Exception as e:
        app.logger.error(f"Errore durante l'indicizzazione del ticket: {e}")
        app.logger.error(traceback.format_exc())
        return jsonify({'error': str(e)}), 500


# Endpoint per la ricerca di ticket simili
@app.route('/api/smartsupport/search', methods=['POST'])
def search_similar_tickets():
    try:
        data = request.get_json()
        if not data or 'text' not in data or 'client' not in data:
            return jsonify({'error': 'Parametri "text" e "client" sono obbligatori.'}), 400
            
        text = data['text']
        client = data['client']
        limit = int(data.get('limit', 5))
        
        app.logger.info(f"Ricerca ticket simili per cliente '{client}'...")
        
        # Calcolo embedding
        query_vector = get_text_embedding(text)
        
        # Ricerca
        results = db_mgr.search_similar(client, query_vector, limit=limit)
        
        return jsonify({'status': 'success', 'results': results})
    except Exception as e:
        app.logger.error(f"Errore durante la ricerca di ticket simili: {e}")
        app.logger.error(traceback.format_exc())
        return jsonify({'error': str(e)}), 500



# -----------------------------
# Utility dataset esempi
# -----------------------------




@app.route('/classify', methods=['POST'])
def classify():
    try:
        data = request.get_json()
        if not data or 'text' not in data:
            app.logger.warning("Invalid input for /classify. Request must be JSON with a 'text' field.")
            return jsonify({'error': 'Invalid input. Request must be JSON with a \'text\' field.'}), 400

        text_to_classify = data['text']
        if len(text_to_classify) > 10000:
            app.logger.warning("Input text for /classify is too long.")
            return jsonify({'error': 'Input text is too long.'}), 400

        if bot_human_classifier:
            with classification_lock:
                if bot_human_classifier.task == "zero-shot-classification":
                    candidate_labels = ["Human", "Bot"]
                    result = bot_human_classifier(text_to_classify, candidate_labels)
                else:
                    result = bot_human_classifier(text_to_classify, truncation=True)
            best_label = result[0]['label']
        else:
            best_label = 'Human' # Fallback

        return jsonify({'category': best_label})

    except Exception as e:
        app.logger.error(f"An error occurred during classification: {e}")
        app.logger.error(traceback.format_exc())
        return jsonify({'error': 'An internal error occurred during classification.'}), 500

@app.route('/api/rate-email', methods=['GET','POST'])
def rate_email():
    try:
        data = request.get_json()
        if not data or 'email' not in data or 'score' not in data:
            app.logger.warning("Invalid input for /rate-email. Request must be JSON with 'email' and 'score' fields.")
            return jsonify({'error': 'Invalid input. Request must be JSON with \'email\' and \'score\' fields.'}), 400

        email = data['email']
        score = data['score']

        subject = email.get('subject', '')
        body = email.get('body', '')
        
        file_path = 'llm_training_data_importance.csv'
        
        with open(file_path, 'a', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow([subject, body, score])
        
        app.logger.info(f"Rating saved for email with subject: {subject}")
        return jsonify({'message': 'Rating saved successfully.'})

    except Exception as e:
        app.logger.error(f"An error occurred during rating: {e}")
        app.logger.error(traceback.format_exc())
        return jsonify({'error': 'An internal error occurred during rating.'}), 500



@app.route('/reload-model', methods=['POST'])
def reload_model():
    global bot_human_classifier
    try:
        app.logger.info("Request to reload model received.")
        if os.path.exists(bot_human_model_path) and os.listdir(bot_human_model_path):
            with classification_lock:
                app.logger.info(f"Reloading bot/human model from {bot_human_model_path}...")
                bot_human_classifier = pipeline("text-classification", model=bot_human_model_path)
            app.logger.info("Model reloaded successfully.")
            return jsonify({'message': 'Model reloaded successfully.'})
        else:
            app.logger.warning("Model path empty or not found during reload.")
            return jsonify({'error': 'Model files not found.'}), 404
    except Exception as e:
        app.logger.error(f"Error reloading model: {e}")
        app.logger.error(traceback.format_exc())
        return jsonify({'error': f"Error reloading model: {e}"}), 500

@app.route('/api/health', methods=['GET'])
def health_check():
    try:
        # Check if the models are loaded and responsive
        if bot_human_classifier is not None:
            # You could add a more sophisticated check here, e.g., a quick inference
            return jsonify({'status': 'ok'})
        else:
            return jsonify({'status': 'error', 'message': 'Models not loaded'}), 500
    except Exception as e:
        app.logger.error(f"Health check failed: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

if __name__ == '__main__':
    # Use a production-ready WSGI server like Gunicorn or uWSGI instead of the Flask development server.
    # Example with Gunicorn: gunicorn --workers 4 --bind 0.0.0.0:5001 prediction_server:app
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain('certs/cert.pem', 'certs/key.pem')
    app.logger.info("Starting prediction server...")
    host = os.environ.get('PREDICTION_SERVER_HOST', '0.0.0.0')
    port = int(os.environ.get('PREDICTION_SERVER_PORT', 5001))
    app.run(host=host, port=port, debug=False, ssl_context=context, threaded=True)
