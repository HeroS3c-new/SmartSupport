import pandas as pd

# Carica il dataset
df = pd.read_csv('dataset/spam_assassin.csv')

# La colonna 'text' è già presente.
# La colonna 'target' ha 1 per spam e 0 per non spam.
# Mapperemo lo spam a "Bot" e il non spam a "Human".
df['category'] = df['target'].apply(lambda x: 'Bot' if x == 1 else 'Human')

# Crea un nuovo dataframe solo con testo e categoria
output_df = df[['text', 'category']]

# Salva il nuovo dataset
output_df.to_csv('llm_training_data_bot_human.csv', index=False)
