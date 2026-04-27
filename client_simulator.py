import requests
import time
import warnings

# Sopprime solo l'avviso InsecureRequestWarning da urllib3 necessario
from requests.packages.urllib3.exceptions import InsecureRequestWarning
warnings.simplefilter('ignore', InsecureRequestWarning)

# Configurazione
API_ENDPOINT = "https://localhost/api/emails"
# Puoi cambiare il limite di email da recuperare
EMAIL_LIMIT = 25 
# Intervallo in secondi tra ogni recupero
FETCH_INTERVAL = 30 

def simulate_client():
    """
    Simulates a client fetching emails from the API endpoint in a continuous loop.
    """
    print("--- Client Simulator Started ---")
    print(f"Targeting endpoint: {API_ENDPOINT}")
    print(f"Fetching emails every {FETCH_INTERVAL} seconds.")
    print("---------------------------------")
    
    while True:
        try:
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Simulating request to fetch {EMAIL_LIMIT} emails...")
            
            # Il `verify=False` è necessario perché il server usa un certificato autofirmato
            response = requests.get(f"{API_ENDPOINT}?limit={EMAIL_LIMIT}", verify=False)
            
            response.raise_for_status()  # Solleva un'eccezione per i codici di stato errati (4xx o 5xx)
            
            data = response.json()
            email_count = len(data.get('emails', []))
            
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] SUCCESS: Received {email_count} emails.")

        except requests.exceptions.HTTPError as http_err:
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] ERROR: HTTP error occurred: {http_err} - Status code: {http_err.response.status_code}")
        except requests.exceptions.ConnectionError as conn_err:
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] ERROR: Connection error. Is the server running? Details: {conn_err}")
        except requests.exceptions.RequestException as err:
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] ERROR: An unexpected error occurred: {err}")
        
        print(f"Waiting for {FETCH_INTERVAL} seconds before next fetch...")
        time.sleep(FETCH_INTERVAL)

if __name__ == "__main__":
    simulate_client()