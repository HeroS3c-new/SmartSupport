import os
import subprocess

# Imposta KAGGLE_CONFIG_DIR sulla directory corrente
os.environ['KAGGLE_CONFIG_DIR'] = os.getcwd()

# Crea la directory del dataset se non esiste
os.makedirs('dataset', exist_ok=True)

# Scarica il dataset usando la CLI di Kaggle
command = [
    "kaggle", "datasets", "download",
    "-d", "ganiyuolalekan/spam-assassin-email-classification-dataset",
    "-p", "dataset",
    "--unzip"
]

try:
    subprocess.run(command, check=True)
    print("Dataset downloaded and unzipped to dataset/")
except FileNotFoundError:
    print("Error: kaggle command not found. Please make sure kaggle is installed and in your PATH.")
except subprocess.CalledProcessError as e:
    print(f"Error downloading dataset: {e}")