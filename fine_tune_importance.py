import pandas as pd
from transformers import AutoTokenizer, AutoModelForSequenceClassification, Trainer, TrainingArguments
import torch
from sklearn.model_selection import train_test_split
import logging
import os
from logging.handlers import RotatingFileHandler

# --- Impostazione del Logging ---
log_dir = 'logs/fine_tune_llm'
os.makedirs(log_dir, exist_ok=True)

logger = logging.getLogger('FineTuneLLMLogger')
logger.setLevel(logging.INFO)

# Impedisce la propagazione al logger root
logger.propagate = False

# Pulisce i gestori esistenti
if logger.hasHandlers():
    logger.handlers.clear()

# Formattatore
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# Gestore per i log combinati
combined_log_path = os.path.join(log_dir, 'combined.log')
combined_handler = RotatingFileHandler(combined_log_path, maxBytes=10000, backupCount=1)
combined_handler.setLevel(logging.INFO)
combined_handler.setFormatter(formatter)
logger.addHandler(combined_handler)

# Gestore per i log di errore
erro_log_path = os.path.join(log_dir, 'error.log')
error_handler = RotatingFileHandler(erro_log_path, maxBytes=10000, backupCount=1)
error_handler.setLevel(logging.ERROR)
error_handler.setFormatter(formatter)
logger.addHandler(error_handler)
# --- Fine Impostazione del Logging ---


# --- Configurazione ---
MODEL_NAME = "roberta-base"
TRAINING_DATA_FILE = "llm_training_data_importance.csv"
OUTPUT_DIR = "./fine_tuned_llm_model_importance"

def load_dataset():
    try:
        df = pd.read_csv(TRAINING_DATA_FILE, header=None, names=['text', 'score'])
        df.dropna(subset=['score'], inplace=True)

        labels = sorted(df['score'].unique().tolist())
        label2id = {label: i for i, label in enumerate(labels)}
        id2label = {i: label for i, label in enumerate(labels)}
        df['label'] = df['score'].map(label2id)
        logger.info(f"Dataset loaded successfully. Found {len(df)} samples.")
        logger.info(f"Label mapping: {label2id}")
        return df, label2id, id2label
    except FileNotFoundError:
        logger.error(f"Error: Training data file not found at '{TRAINING_DATA_FILE}'.")
        return None, None, None

# --- 2. Tokenizzazione dei Dati ---
class EmailDataset(torch.utils.data.Dataset):
    def __init__(self, encodings, labels):
        self.encodings = encodings
        self.labels = labels

    def __getitem__(self, idx):
        item = {key: torch.tensor(val[idx]) for key, val in self.encodings.items()}
        item['labels'] = torch.tensor(self.labels[idx])
        return item

    def __len__(self):
        return len(self.labels)

def tokenize_data(df, tokenizer):
    train_texts, val_texts, train_labels, val_labels = train_test_split(
        df['text'].tolist(), df['label'].tolist(), test_size=0.2, random_state=42
    )

    train_encodings = tokenizer(train_texts, truncation=True, padding=True, max_length=512)
    val_encodings = tokenizer(val_texts, truncation=True, padding=True, max_length=512)

    train_dataset = EmailDataset(train_encodings, train_labels)
    val_dataset = EmailDataset(val_encodings, val_labels)

    return train_dataset, val_dataset

# --- 3. Logica Principale di Fine-Tuning ---
def main():
    logger.info("--- Starting LLM Fine-Tuning Script ---")
    
    # Load dataset
    df, label2id, id2label = load_dataset()
    if df is None:
        return

    # Load tokenizer and model
    logger.info(f"Loading pre-trained model: {MODEL_NAME}")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_NAME, 
        num_labels=len(label2id),
        id2label=id2label,
        label2id=label2id,
        ignore_mismatched_sizes=True
    )

    # Create tokenized datasets
    logger.info("Tokenizing dataset...")
    train_dataset, val_dataset = tokenize_data(df, tokenizer)

    # Define training arguments
    training_args = TrainingArguments(
        output_dir=OUTPUT_DIR,
        num_train_epochs=3,          # Numero di epoche di addestramento
        per_device_train_batch_size=2, # Dimensione del batch per l'addestramento
        per_device_eval_batch_size=2,  # Dimensione del batch per la valutazione
        warmup_steps=500,              # Numero di passaggi di riscaldamento
        weight_decay=0.01,             # Forza del decadimento del peso
        logging_dir=log_dir,          # Directory per la memorizzazione dei log
        logging_steps=10,
        eval_strategy="epoch",   # Valuta alla fine di ogni epoca
    )

    # Crea un'istanza del Trainer
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset
    )

    # Avvia il fine-tuning
    logger.info("--- Starting Fine-Tuning ---")
    trainer.train()
    logger.info("--- Fine-Tuning Finished ---")

    # Salva il modello e il tokenizer sottoposti a fine-tuning
    logger.info(f"Saving fine-tuned model to {OUTPUT_DIR}")
    model.save_pretrained(OUTPUT_DIR, safe_serialization=False)
    tokenizer.save_pretrained(OUTPUT_DIR)
    logger.info("--- Model Saved Successfully ---")

if __name__ == "__main__":
    main()
