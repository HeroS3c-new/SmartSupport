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
    RobertaForSequenceClassification,
)
from transformers.utils import is_bitsandbytes_available
import torch
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
    app.run(host='0.0.0.0', port=5001, debug=False, ssl_context=context, threaded=True)
