# MaeSkimmer 🚀

MaeSkimmer è un'applicazione avanzata per la gestione intelligente delle email e l'automazione dei ticket su Redmine. Combina un backend Node.js, un server di classificazione Python basato su Machine Learning e una dashboard frontend moderna.

## Caratteristiche Principali

- 📧 **Integrazione Gmail & Threading**: Recupera ed elabora automaticamente le email (ottimizzato per "Cloud Monitor") raggruppandole in conversazioni (threading) cronologiche ed espandibili, con supporto alla selezione multipla (Shift-click).
- 🐞 **Automazione Redmine**: Crea, aggiorna e risolve in autonomia i ticket associati agli allarmi infrastrutturali basandosi sullo stato dell'evento (OK/CRITICAL/WARNING).
- 🤖 **Classificazione AI & Riaddestramento Continuo**: Microservizio Transformers per la classificazione *Bot* vs *Human*, con riaddestramento incrementale automatico programmato ogni giorno alle 20:00 (o manuale via API) e ricaricamento a caldo del modello (`/reload-model`) senza tempi di inattività.
- 🧠 **SmartSupport AI Advisor (Ricerca Semantica)**: Assistente intelligente per la risoluzione dei ticket. Calcola gli embedding semantici delle email e li confronta in tempo reale (SQLite + somiglianza coseno tramite `sentence-transformers/all-MiniLM-L6-v2`) con lo storico dei ticket chiusi di Redmine. Sintetizza la soluzione adottata con Google Gemini 3.5 Flash proponendola in formato Textile all'operatore in fase di assegnazione del ticket.
- 🔐 **Sicurezza Multilivello & Anti-Typosquatting**: Autenticazione a cascata (Local bcrypt + LDAP/LDAPS Active Directory) con MFA TOTP. Include controlli sulle intestazioni di sicurezza Gmail (SPF/DKIM/DMARC) e sul mittente per prevenire il typosquatting (distanza di Levenshtein sulle label e sui domini) integrandosi con un sistema di auto-discovery dei domini dei clienti censiti in `client_domains.json`.
- 📊 **Dashboard Efficienza & SLA**: Calcolo automatico e visualizzazione dei KPI di SLA compliance, tempi medi di presa in carico (MTTA) e risoluzione (MTTR), tasso di First Contact Resolution (FCR) e riapertura, grafici di andamento orario e allarmi Checkmk, oltre al carico di lavoro utenti ordinato e la coda dei ticket non assegnati.
- 📬 **Modulo Risposta & Allegati**: Editor rich-text con ridimensionamento dinamico (fullscreen/floating), drag-and-drop per allegare file, visualizzazione/download allegati originari, e manipolazione interattiva delle immagini copiate (scaling percentuale e resize tramite mouse).
- 🔄 **Backup Hub, Cestino & Auto-Discovery**: Hub per monitorare i log di backup con calcolo trigonometrico circolare per definire scadenze dinamiche (Deadline), tester regex in tempo reale debounced, auto-discovery asincrono dei flussi, e gestione "Cestino" (esclusione temporanea di email dai flussi di calcolo statistico).
- 📝 **Registro Email Inviate**: Log storico persistente su file `sent_emails.json` delle email in uscita (risposte, inoltri, notifiche) con rotazione automatica (max 200 record) e pannello di ricerca/visualizzazione integrato.
- 🔌 **Reverse Proxy Integrato**: Reverse proxy Express asincrono su `/autoblock` per deviare il traffico direttamente verso la dashboard locale AutoBlock (porta 5005).

---

## Prerequisiti

Prima di iniziare, assicurati di avere installato:
- [Node.js](https://nodejs.org/) (v16 o superiore)
- [Python 3.8+](https://www.python.org/)
- Un account Google con [Gmail API abilitata](https://developers.google.com/gmail/api/quickstart/js)
- Accesso a un'istanza Redmine (con API Key)
- Una chiave API Google Gemini (Gemini 3.5 Flash) per la valutazione massiva dell'importanza delle email.

---

## Setup del Progetto

### 1. Clonazione e Dipendenze Node.js
```bash
# Installa le dipendenze del backend
npm install
```

### 2. Dipendenze Python (Server di Predizione)
Si consiglia di utilizzare un ambiente virtuale:
```bash
# Crea un ambiente virtuale
python -m venv venv
# Attivalo (Windows)
.\venv\Scripts\activate
# Attivalo (Linux/macOS)
source venv/bin/activate

# Installa le dipendenze
pip install -r requirements.txt
```

### 3. Configurazione Ambiente
1. Copia il file `.env.example` in `.env`:
   ```bash
   cp .env.example .env
   ```
2. Modifica `.env` con le tue chiavi API, credenziali Redmine e configurazioni LDAP.
3. Copia `users.json.example` in `users.json` per configurare gli utenti locali.

### 4. Configurazione Google API
1. Scarica il file `client_secret.json` dalla Google Cloud Console.
2. Inseriscilo nella root del progetto.
3. Esegui il comando per generare il token di accesso iniziale:
   ```bash
   node generate_token.js
   ```
   Segui le istruzioni nel terminale per autorizzare l'applicazione.

---

## Lancio dell'Applicazione

Per il corretto funzionamento, devono essere attivi sia il server Node.js che il server di classificazione Python.

### Avvio Unificato (Consigliato su Windows)
È possibile avviare contemporaneamente in due console separate sia Express che il Prediction server eseguendo lo script Batch preconfigurato:
```bash
.\start_servers.bat
```

### Avvio in Modalità Debug
Per scopi di sviluppo, testing locale ed evitare l'invio di email reali o l'uso di porte privilegiate (80/443), avvia lo script batch di debug:
```bash
.\start_servers_debug.bat
```
Questo imposta la variabile d'ambiente `MAESKIMMER_MODE=debug`, abilitando le porte `8080` (HTTP) e `8443` (HTTPS) e deviando la trasmissione delle e-mail in un file di log locale in chiaro (`logs/emails/debug-emails.log`).

### Avvio Manuale (Su console distinte)
1. **Server di Predizione Python**:
   ```bash
   # Assicurati che l'ambiente virtuale sia attivo
   python prediction_server.py
   ```
   *Il server sarà in ascolto sulla porta 5001 (HTTPS).*

2. **Server Principale Node.js**:
   ```bash
   node index.js
   ```
   *L'applicazione sarà accessibile all'indirizzo configurato (default https://localhost).*

---

## Funzionamento Tecnico

1. **Sincronizzazione**: `index.js` esegue un polling asincrono su Gmail ogni 15 secondi, archiviando le email lette e non lette in `email_cache.json` usando un lock asincrono (`cacheLock`) per evitare corruzioni.
2. **Classificazione AI**: Invia il corpo delle email al server Python. Se il server risponde con successo, classifica come *Bot* o *Human*. In caso di errore, applica un fallback a *Human*. Supporta riaddestramenti incrementali giornalieri partendo dall'ultimo modello addestrato.
3. **Automazione Ticket**: Estrae Host, Servizio e Stato (OK, CRIT, WARN) dagli allarmi. Crea ticket per nuovi allarmi o vi appende note se già aperti. Risolve/chiude automaticamente i ticket su Redmine quando riceve l'email di ripristino ("OK").
4. **Calcolo Statistiche Circolari**: Il Backup Hub calcola media e deviazione standard circolare trigonometrica per individuare gli orari di ricezione regolari dei backup ed evidenziare ritardi o mancanze rispetto a scadenze adattive.
5. **Monitoraggio Ticket Chiusi**: La funzione `monitorClosedTickets` controlla ogni 2 minuti (120 secondi) i ticket chiusi su Redmine (status_id = 5) nei progetti configurati per notificare la risoluzione agli utenti. Utilizza il campo custom "Stato notifica" (= 2) per tracciare l'invio ed evitare duplicati.
6. **SmartSupport AI Advisor**: All'atto della chiusura formale dei ticket da parte della routine `monitorClosedTickets` (o tramite prima indicizzazione massiva via `/api/smartsupport/sync-historic-tickets`), i ticket vengono vettorizzati tramite il modello `sentence-transformers/all-MiniLM-L6-v2` e salvati nel DB SQLite `smartsupport.db`. Alla ricezione di una richiesta, l'endpoint `/api/smartsupport/assist` effettua una ricerca per somiglianza coseno e sintetizza una soluzione integrando Google Gemini 3.5 Flash.
7. **Controllo Sicurezza & Typosquatting**: Al polling o recupero email, il backend convalida i record di sicurezza di autenticazione dell'header `Authentication-Results` (SPF, DKIM, DMARC) ed esegue controlli anti-typosquatting tramite distanza di Levenshtein ed inclusioni delle stringhe dei domini/label rispetto alle anagrafiche certificate in `client_domains.json`. I domini attendibili vengono auto-popolati se presentano almeno 3 interazioni prive di potenziali conflitti.

---

## File Essenziali nel Repository

- [index.js](file:///f:/Produzione/MaeSkimmer/index.js): Server principale Node.js Express. Gestisce polling, cache lock, automazione Redmine, statistiche dei backup, controlli di sicurezza, integrazione Gemini e reverse proxy.
- [prediction_server.py](file:///f:/Produzione/MaeSkimmer/prediction_server.py): Server Flask HTTPS per la classificazione AI locale (Human/Bot), vettorizzazione ed embedding dei ticket storici tramite sentence-transformers, e gestione del database SQLite `smartsupport.db`.
- [smartsupport.db](file:///f:/Produzione/MaeSkimmer/smartsupport.db): Database relazionale SQLite contenente lo storico dei ticket chiusi vettorizzati e l'estensione `sqlite-vss` per la ricerca semantica.
- [client_domains.json](file:///f:/Produzione/MaeSkimmer/client_domains.json): Anagrafica dei domini legittimi associati a ciascun cliente censito in Redmine per la prevenzione del typosquatting.
- [sent_emails.json](file:///f:/Produzione/MaeSkimmer/sent_emails.json): File JSON locale per la tracciabilità e la rotazione automatica (limite max 200 record) dei log delle email inviate dal sistema.
- [fine_tune_bot_human.py](file:///f:/Produzione/MaeSkimmer/fine_tune_bot_human.py): Script di fine-tuning incrementale del modello Transformers.
- [clean_dataset.py](file:///f:/Produzione/MaeSkimmer/clean_dataset.py): Utility per la pulizia, deduplica e formattazione del dataset di addestramento.
- [classification_overrides.json](file:///f:/Produzione/MaeSkimmer/classification_overrides.json): Eccezioni manuali per la forzatura statica delle categorie.
- [redmine_issues_cache.json](file:///f:/Produzione/MaeSkimmer/redmine_issues_cache.json): Cache delle problematiche Redmine per il calcolo rapido delle metriche.
- [changelog.md](file:///f:/Produzione/MaeSkimmer/changelog.md): Registro storico delle modifiche apportate.
- [public/](file:///f:/Produzione/MaeSkimmer/public): Codice sorgente del client (HTML, CSS e JS per la dashboard e la documentazione).
- [start_servers.bat](file:///f:/Produzione/MaeSkimmer/start_servers.bat): Script batch di avvio coordinato dei server.
- [package.json](file:///f:/Produzione/MaeSkimmer/package.json) & [requirements.txt](file:///f:/Produzione/MaeSkimmer/requirements.txt): Dipendenze software.

