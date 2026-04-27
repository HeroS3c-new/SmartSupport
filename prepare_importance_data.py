import pandas as pd

# Carica il dataset di Kaggle
df_kaggle = pd.read_csv('dataset/dataset-tickets-multi-lang-4-20k.csv')
df_kaggle['text'] = df_kaggle['subject'].fillna('') + ',""' + df_kaggle['body'].fillna('') + '""'
priority_mapping = {'low': 0.2, 'medium': 0.5, 'high': 0.8}
df_kaggle['score'] = df_kaggle['priority'].map(priority_mapping)
df_kaggle.dropna(subset=['score'], inplace=True)
df_kaggle = df_kaggle[['text', 'score']]

# Salva il nuovo dataset
df_kaggle.to_csv('llm_training_data_importance.csv', index=False, header=False)