import os
import subprocess

os.environ['KAGGLE_CONFIG_DIR'] = '.'
subprocess.run(['kaggle', 'datasets', 'download', '-d', 'tobiasbueck/multilingual-customer-support-tickets', '-p', 'dataset', '--unzip'])
