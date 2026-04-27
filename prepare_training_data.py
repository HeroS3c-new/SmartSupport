import pandas as pd

# Carica il dataset
df = pd.read_csv('dataset/dataset-tickets-multi-lang-4-20k.csv')

# Crea il nuovo contenuto combinando oggetto e corpo
df['content'] = df['subject'].fillna('') + ',""' + df['body'].fillna('') + '""'

# Mappa le priorità ai punteggi
priority_mapping = {'low': 0.2, 'medium': 0.5, 'high': 0.8}
df['score'] = df['priority'].map(priority_mapping)

# Elimina le righe con punteggi mancanti
df.dropna(subset=['score'], inplace=True)

# Crea un nuovo dataframe solo con il contenuto e il punteggio
output_df = df[['content', 'score']]

# Salva il nuovo dataset
output_df.to_csv('email_dataset_example.csv', index=False, header=False)
