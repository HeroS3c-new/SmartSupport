require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const helmet = require('helmet');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const winston = require('winston');
const session = require('express-session');
const bcrypt = require('bcrypt');
require('winston-daily-rotate-file');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ActiveDirectory = require('activedirectory2');
const otplib = require('otplib');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

// --- Configurazione Logger ---
const logDir = 'logs/nodejs';
if (!fsSync.existsSync(logDir)) {
    fsSync.mkdirSync(logDir, { recursive: true });
}

// Trasporto DailyRotateFile per log di errore
const errorRotateTransport = new winston.transports.DailyRotateFile({
    level: 'error',
    filename: path.join(logDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m', // Ruota se il file supera i 20MB
    maxFiles: '14d', // Mantieni i log per 14 giorni
});

// Trasporto DailyRotateFile per log combinati
const combinedRotateTransport = new winston.transports.DailyRotateFile({
    filename: path.join(logDir, 'combined-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m', // Ruota se il file supera i 20MB
    maxFiles: '14d', // Mantieni i log per 14 giorni
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'user-service' },
    transports: [
        errorRotateTransport,
        combinedRotateTransport,
    ],
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple(),
    }));
}
// --- Fine Configurazione Logger ---

const app = express();
const port = 80;
const httpsPort = 443;

// app.use(helmet()); // Rimosso helmet perché potrebbe interferire con CSP
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false })); // Disable default index.html serving

app.use(session({
    secret: process.env.SESSION_SECRET || 'maeskimmer-super-secret-key-12345',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

logger.info('MaeSkimmer Server starting up...');
console.log('MaeSkimmer Server starting up...');

// --- Middleware di Autenticazione ---
const USERS_PATH = path.join(__dirname, 'users.json');

async function readUsers() {
    try {
        const data = await fs.readFile(USERS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        logger.error('Errore lettura users.json:', error);
        return {};
    }
}

async function writeUsers(users) {
    try {
        await fs.writeFile(USERS_PATH, JSON.stringify(users, null, 2), 'utf8');
    } catch (error) {
        logger.error('Errore scrittura users.json:', error);
    }
}

// --- Configurazione LDAP ---
const ldapConfig = {
    url: process.env.LDAP_URL || 'ldap://10.100.200.240',
    baseDN: process.env.LDAP_BASE_DN || 'DC=maestrale,DC=local',
};

function authenticateLDAP(username, password) {
    return new Promise((resolve, reject) => {
        const ad = new ActiveDirectory(ldapConfig);
        const upn = `${username}@${process.env.LDAP_DOMAIN || 'maestrale.local'}`;

        ad.authenticate(upn, password, (err, auth) => {
            if (err) {
                if (err.name === 'InvalidCredentialsError') {
                    resolve(false);
                } else {
                    logger.error('Errore LDAP:', err);
                    reject(err);
                }
            } else if (auth) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    const acceptHeader = req.headers.accept || '';
    if (req.xhr || acceptHeader.includes('application/json')) {
        return res.status(401).json({ message: 'Sessione scaduta o non valida.' });
    }
    res.redirect('/login');
}

// Middleware per loggare le richieste
app.use((req, res, next) => {
    logger.info({
        message: 'Richiesta ricevuta',
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
    });
    next();
});

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CLASSIFICATION_API_URL = 'https://localhost:5001/classify';
const CSV_DATASET_PATH = path.join(__dirname, 'email_dataset_example.csv');
const LLM_TRAINING_DATA_PATH = path.join(__dirname, 'llm_training_data.csv');
const RECLASSIFY_TRAINING_DATA_PATH = path.join(__dirname, 'llm_training_data.csv');
const EMAIL_CACHE_PATH = path.join(__dirname, 'email_cache.json');

// --- Configurazione Redmine ---
const REDMINE_API_KEY = process.env.REDMINE_API_KEY || '6c82584b1a055fa3fb9e807c80fd3666174ca79f';
const REDMINE_PROJECT_ID = parseInt(process.env.REDMINE_PROJECT_ID, 10) || 7291;
const REDMINE_URL = process.env.REDMINE_URL || 'https://projects.maestrale.it/issues.json';

const redmineHttpsAgent = new https.Agent({
    rejectUnauthorized: false
});

// --- Configurazione Nodemailer (SMTP) ---
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mailgun.org',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: false, // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

async function createRedmineTicket(email, statusStr = '') {
    // 3: Alta (CRIT), 2: Normale (WARN, UNKN, etc.)
    let priorityId = 2;
    if (statusStr.includes('CRIT')) {
        priorityId = 3;
    }

    const issueData = {
        issue: {
            project_id: REDMINE_PROJECT_ID,
            subject: email.subject,
            description: `Mittente: ${email.from}\n\nSnippet: ${email.snippet}\n\nCorpo:\n${email.body}`,
            tracker_id: 1,
            status_id: 1, // 1: New
            priority_id: priorityId,
            assigned_to_id: 1021 // 1021: Group "SysAdmin Livello 1"
        }
    };

    try {
        const response = await axios.post(REDMINE_URL, issueData, {
            headers: {
                'X-Redmine-API-Key': REDMINE_API_KEY,
                'Content-Type': 'application/json',
                'User-Agent': 'MaeSkimmer-AutoSync'
            },
            httpsAgent: redmineHttpsAgent,
            timeout: 15000
        });

        if (response.data && response.data.issue) {
            logger.info(`Ticket Redmine creato: ID ${response.data.issue.id} per email ${email.id}`);
            return response.data.issue.id;
        }
    } catch (error) {
        logger.error(`Errore creazione ticket Redmine per email ${email.id}:`, error.response ? JSON.stringify(error.response.data) : error.message);
    }
    return null;
}

async function updateRedmineTicket(ticketId, email, statusStr = '') {
    let priorityId = 2;
    if (statusStr.includes('CRIT')) {
        priorityId = 3;
    }

    const issueData = {
        issue: {
            subject: email.subject,
            priority_id: priorityId,
            notes: `Aggiornamento automatico stato: ${statusStr}\n\nMittente: ${email.from}\n\nSnippet: ${email.snippet}\n\nCorpo:\n${email.body}`
        }
    };

    try {
        const singleTicketUrl = REDMINE_URL.replace('.json', `/${ticketId}.json`);
        await axios.put(singleTicketUrl, issueData, {
            headers: {
                'X-Redmine-API-Key': REDMINE_API_KEY,
                'Content-Type': 'application/json',
                'User-Agent': 'MaeSkimmer-AutoSync'
            },
            httpsAgent: redmineHttpsAgent,
            timeout: 10000
        });
        logger.info(`Ticket Redmine ${ticketId} aggiornato con nuovo stato (${statusStr}) e priorità.`);
        return true;
    } catch (error) {
        logger.error(`Errore durante l'aggiornamento del ticket Redmine ${ticketId}:`, error.response ? JSON.stringify(error.response.data) : error.message);
    }
    return false;
}

async function resolveRedmineTicket(ticketId, host, service) {
    const issueData = {
        issue: {
            status_id: 5, // 5: Chiuso
            notes: `Risolto automaticamente: il servizio ${host}/${service} è tornato allo stato OK.`
        }
    };

    try {
        const singleTicketUrl = REDMINE_URL.replace('.json', `/${ticketId}.json`);
        await axios.put(singleTicketUrl, issueData, {
            headers: {
                'X-Redmine-API-Key': REDMINE_API_KEY,
                'Content-Type': 'application/json',
                'User-Agent': 'MaeSkimmer-AutoSync'
            },
            httpsAgent: redmineHttpsAgent,
            timeout: 10000
        });
        logger.info(`Ticket Redmine ${ticketId} contrassegnato come Risolto (${host}/${service}).`);
        return true;
    } catch (error) {
        logger.error(`Errore durante la risoluzione del ticket Redmine ${ticketId}:`, error.response ? JSON.stringify(error.response.data) : error.message);
    }
    return false;
}

function extractHostService(subject) {
    // Pattern tipico: "Checkmk: <Host>/<Service> <Status>"
    //const match = subject.match(/Checkmk:\s+([^\/]+)\/([\s\S]+?)\s*(?:[?–\->›]+\s*)?\b(OK|CRIT|WARN|UNKNOWN|UP|DOWN)\b/i);
    // Esempio: "Checkmk: SRV-APP01/CPU load OK" oppure "Checkmk: SRV-APP01/CPU load CRITICAL"
    // Migliorato per gestire transizioni (es. WARN -> CRIT) e mantenere pulito il nome servizio
    const match = subject.match(/Checkmk:\s+([^\/]+)\/([\s\S]+?)\s*(?:\b(?:OK|CRIT|WARN|UNKNOWN|UP|DOWN)\s*[?–\->›]+\s*)?\b(OK|CRIT|WARN|UNKNOWN|UP|DOWN)\b/i);
    if (match) {
        return {
            host: match[1].trim(),
            service: match[2].trim(),
            status: match[3].trim().toUpperCase()
        };
    }
    // Fallback per altri formati se necessari
    return null;
}

async function checkExistingTicket(host, service) {
    try {
        const query = `${host}/${service}`;
        const searchUrl = `${REDMINE_URL}?project_id=${REDMINE_PROJECT_ID}&status_id=open&subject=~${encodeURIComponent(query)}`;

        const response = await axios.get(searchUrl, {
            headers: {
                'X-Redmine-API-Key': REDMINE_API_KEY,
                'User-Agent': 'MaeSkimmer-AutoSync'
            },
            httpsAgent: redmineHttpsAgent,
            timeout: 10000
        });

        if (response.data && response.data.issues && response.data.issues.length > 0) {
            // Verifica ulteriore per evitare falsi positivi
            const exactMatch = response.data.issues.find(issue =>
                issue.subject.includes(`${host}/${service}`)
            );
            return exactMatch ? exactMatch.id : null;
        }
    } catch (error) {
        logger.error(`Errore durante il controllo ticket esistenti per ${host}/${service}:`, error.message);
    }
    return null;
}

async function associateRedmineTicket(emailData) {
    if (emailData.redmineTicketId) {
        logger.debug(`Email ${emailData.id} già associata a ticket ${emailData.redmineTicketId}. Salto associazione.`);
        return;
    }
    const info = extractHostService(emailData.subject);
    if (info) {
        const existingTicketId = await checkExistingTicket(info.host, info.service);
        if (info.status === 'OK' || info.status === 'UP') {
            if (existingTicketId) {
                logger.info(`Email di recovery: Ticket esistente trovato (${existingTicketId}) per ${info.host}/${info.service}. Associo ID per chiusura manuale.`);
                emailData.redmineTicketId = existingTicketId;
            } else {
                logger.debug(`Email di recovery saltata per ticket automatico (nessun ticket aperto): ${emailData.subject}`);
            }
        } else {
            if (!existingTicketId) {
                const ticketId = await createRedmineTicket(emailData, info.status);
                if (ticketId) {
                    emailData.redmineTicketId = ticketId;
                }
            } else {
                logger.info(`Ticket già esistente (${existingTicketId}) per ${info.host}/${info.service}. Aggiornamento ticket in corso...`);
                await updateRedmineTicket(existingTicketId, emailData, info.status);
                emailData.redmineTicketId = existingTicketId;
            }
        }
    } else {
        const existingTicketId = await checkExistingTicketBySubject(emailData.subject);
        if (!existingTicketId) {
            const ticketId = await createRedmineTicket(emailData);
            if (ticketId) {
                emailData.redmineTicketId = ticketId;
            }
        } else {
            logger.info(`Ticket già esistente (${existingTicketId}) per soggetto (fallback). Aggiornamento ticket...`);
            await updateRedmineTicket(existingTicketId, emailData);
            emailData.redmineTicketId = existingTicketId;
        }
    }
}

async function syncRedmineTickets() {
    logger.info('Avvio sincronizzazione automatica Redmine...');
    try {
        const auth = await authorize();
        if (!auth) return;

        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'from:"Cloud Monitor" is:unread after:1d',
            maxResults: 50
        });

        const messages = res.data.messages || [];
        if (messages.length === 0) {
            logger.info('Nessuna nuova email da Cloud Monitor da elaborare.');
            return;
        }

        const emailCache = await readEmailCache();
        let cacheUpdated = false;
        const processedMessageIds = [];

        for (const message of messages) {
            const id = message.id;

            let emailData = emailCache[id];
            if (!emailData) {
                try {
                    const emailRes = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
                    const { payload, snippet, internalDate, labelIds, threadId } = emailRes.data;
                    const headers = payload.headers;
                    const subject = headers.find(h => h.name === 'Subject')?.value || 'Nessun Oggetto';
                    const from = headers.find(h => h.name === 'From')?.value || 'Cloud Monitor';

                    let body = snippet;
                    const partsToProcess = [payload];
                    while (partsToProcess.length) {
                        const part = partsToProcess.shift();
                        if (part.parts) partsToProcess.push(...part.parts);
                        if (part.mimeType === 'text/plain' && part.body.data) {
                            body = Buffer.from(part.body.data, 'base64').toString('utf8');
                            break;
                        }
                    }

                    emailData = { id, threadId, subject, from, snippet, body, internalDate, labelIds };
                } catch (err) {
                    logger.error(`Errore recupero email ${id}:`, err.message);
                    continue;
                }
            }

            // --- Logica condizionale Redmine ---
            await associateRedmineTicket(emailData);

            emailCache[id] = emailData;
            cacheUpdated = true;

            // Mark as read only if it was unread
            if (emailData.labelIds && emailData.labelIds.includes('UNREAD')) {
                processedMessageIds.push(id);
                // Also remove it from internal state for next loop if needed
                emailData.labelIds = emailData.labelIds.filter(lid => lid !== 'UNREAD');
            }
        }

        if (processedMessageIds.length > 0) {
            try {
                await gmail.users.messages.batchModify({
                    userId: 'me',
                    requestBody: {
                        ids: processedMessageIds,
                        removeLabelIds: ['UNREAD']
                    }
                });
                logger.info(`${processedMessageIds.length} email Cloud Monitor elaborate e marcate come lette.`);
            } catch (err) {
                logger.error('Errore durante batchModify Gmail:', err.message);
            }
        }

        if (cacheUpdated) {
            await writeEmailCache(emailCache);
        }
        logger.info('Sincronizzazione Redmine completata.');
    } catch (error) {
        logger.error('Errore durante la sincronizzazione Redmine:', error);
    }
}

async function checkExistingTicketBySubject(subject) {
    try {
        const searchUrl = `${REDMINE_URL}?project_id=${REDMINE_PROJECT_ID}&status_id=open&subject=~${encodeURIComponent(subject)}`;
        const response = await axios.get(searchUrl, {
            headers: { 'X-Redmine-API-Key': REDMINE_API_KEY, 'User-Agent': 'MaeSkimmer-AutoSync' },
            httpsAgent: redmineHttpsAgent,
            timeout: 5000
        });
        if (response.data && response.data.issues && response.data.issues.length > 0) {
            return response.data.issues[0].id;
        }
    } catch (e) {
        return null;
    }
    return null;
}

// Avvia il sync ogni 15 secondi
setInterval(syncRedmineTickets, 15 * 1000);
// Esegui un primo sync dopo 5 secondi dall'avvio
setTimeout(syncRedmineTickets, 5 * 1000);

async function authorize() {
    const oAuth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.REDIRECT_URI
    );

    try {
        const token = await fs.readFile(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
    } catch (err) {
        logger.error('Impossibile caricare token.json.');
        return null;
    }
    return oAuth2Client;
}

// Funzione di supporto per aggiungere dati al CSV
async function appendToCsv(subject, body, label) {
    // Escapa le virgolette raddoppiandole, e racchiudi il campo tra virgolette
    const escapedSubject = `"${subject.replace(/"/g, '""')}"`;
    const escapedBody = `"${body.replace(/"/g, '""')}"`;
    // Evita che il corpo superi i 1000 caratteri
    const truncatedBody = escapedBody.length > 1000 ? `${escapedBody.slice(0, 1000)}...` : escapedBody;
    const row = `${escapedSubject},${truncatedBody},${label}\n`;

    try {
        // Controlla se il file esiste per decidere se serve l’header
        const fileExists = await fs.access(CSV_DATASET_PATH, fs.constants.F_OK).then(() => true).catch(() => false);
        let content = '';
        if (!fileExists) {
            content = 'subject,body,label\n'; // Aggiungi header se il file è nuovo
        }
        content += row;
        await fs.appendFile(CSV_DATASET_PATH, content);
        logger.info('Dati aggiunti al CSV:', { subject, body, label });
    } catch (error) {
        logger.error('Errore nell’aggiunta al CSV:', error);
    }
}

// Lettura cache email
async function readEmailCache() {
    try {
        const data = await fs.readFile(EMAIL_CACHE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {};
        }
        // Se il JSON è corrotto, prova a caricare una versione parziale o resetta
        if (error instanceof SyntaxError) {
            logger.error('Cache email corrotta (JSON Syntax Error). Tentativo di recupero o reset.', error.message);
            // Backup della cache corrotta per investigazione
            try {
                await fs.copyFile(EMAIL_CACHE_PATH, `${EMAIL_CACHE_PATH}.corrupt`);
            } catch (e) {}
            return {}; 
        }
        logger.error('Errore nella lettura della cache email:', error);
        return {};
    }
}

// Scrittura cache email (Atomica)
async function writeEmailCache(cacheData) {
    const tempPath = `${EMAIL_CACHE_PATH}.tmp`;
    try {
        await fs.writeFile(tempPath, JSON.stringify(cacheData, null, 2), 'utf8');
        await fs.rename(tempPath, EMAIL_CACHE_PATH);
    } catch (error) {
        logger.error('Errore nella scrittura della cache email:', error);
        // Pulisci temp se esiste
        try { await fs.unlink(tempPath); } catch (e) {}
    }
}

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
});

// -----------------------------
// Endpoint di Autenticazione
// -----------------------------

app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const users = await readUsers();

    let authenticated = false;
    let userRecord = users[username];

    // 1. Prova autenticazione locale
    if (userRecord && typeof userRecord === 'string') {
        // Formato vecchio: "username": "hash"
        if (await bcrypt.compare(password, userRecord)) {
            authenticated = true;
        }
    } else if (userRecord && userRecord.password_hash) {
        // Formato nuovo: "username": { "password_hash": "...", ... }
        if (await bcrypt.compare(password, userRecord.password_hash)) {
            authenticated = true;
        }
    }

    // 2. Prova autenticazione LDAP if local failed
    if (!authenticated) {
        try {
            const ldapAuth = await authenticateLDAP(username, password);
            if (ldapAuth) {
                authenticated = true;
                // Inizializza l'utente se non esiste in users.json (LDAP user)
                if (!userRecord) {
                    userRecord = { password_hash: null, mfa_enabled: false };
                }
            }
        } catch (error) {
            logger.error(`Errore durante il tentativo di login LDAP per ${username}:`, error);
        }
    }

    if (authenticated) {
        // Controlla se l'MFA è abilitato
        const mfaEnabled = userRecord && typeof userRecord === 'object' && userRecord.mfa_enabled;

        if (mfaEnabled) {
            // Richiedi secondo step
            req.session.pendingUserId = username;
            logger.info(`Password corretta per ${username}, richiesta verifica MFA.`);
            return res.json({ success: true, mfa_required: true });
        } else {
            // Login completato
            req.session.userId = username;
            logger.info(`Login effettuato: ${username}`);
            return res.json({ success: true });
        }
    }

    logger.warn(`Tentativo di login fallito per ${username}`);
    res.status(401).json({ message: 'Credenziali non valide.' });
});

app.post('/api/login/mfa', async (req, res) => {
    const { otp } = req.body;
    const username = req.session.pendingUserId;

    if (!username) {
        return res.status(401).json({ message: 'Sessione non valida o scaduta.' });
    }

    const users = await readUsers();
    const userRecord = users[username];

    if (!userRecord || !userRecord.mfa_secret) {
        return res.status(400).json({ message: 'MFA non configurato correttamente per questo utente.' });
    }

    const isValid = await otplib.verify({ token: otp, secret: userRecord.mfa_secret });
    console.log(`[MFA DEBUG] Login - User: ${username}, OTP: ${otp}, Result:`, JSON.stringify(isValid));
    if (isValid && isValid.valid) {
        req.session.userId = username;
        delete req.session.pendingUserId;
        logger.info(`Verifica MFA completata per ${username}`);
        return res.json({ success: true });
    } else {
        logger.warn(`Codice OTP errato per ${username}`);
        return res.status(401).json({ message: 'Codice OTP non valido.' });
    }
});

// Endpoint per inizializzare il setup MFA
app.get('/api/mfa/setup', isAuthenticated, async (req, res) => {
    const username = req.session.userId;
    const secret = otplib.generateSecret();
    const otpauth = otplib.generateURI({ secret, label: username, issuer: 'MaeSkimmer' });

    try {
        const qrCodeDataUrl = await QRCode.toDataURL(otpauth);
        // Memorizziamo temporaneamente il segreto nella sessione per la verifica finale
        req.session.tempMfaSecret = secret;
        res.json({
            qrCode: qrCodeDataUrl,
            secret: secret
        });
    } catch (err) {
        logger.error('Errore generazione QR Code:', err);
        res.status(500).json({ message: 'Errore durante la generazione del QR Code.' });
    }
});

// Endpoint per confermare e abilitare l'MFA
app.post('/api/mfa/enable', isAuthenticated, async (req, res) => {
    const { otp } = req.body;
    const username = req.session.userId;
    const secret = req.session.tempMfaSecret;

    if (!secret) {
        return res.status(400).json({ message: 'Sessione di setup MFA non trovata.' });
    }

    const isValid = await otplib.verify({ token: otp, secret });
    console.log(`[MFA DEBUG] Enable - User: ${username}, OTP: ${otp}, Secret: ${secret}, Result:`, JSON.stringify(isValid));
    if (isValid && isValid.valid) {
        const users = await readUsers();

        // Assicuriamoci che l'utente esista come oggetto
        if (!users[username] || typeof users[username] === 'string') {
            const oldHash = typeof users[username] === 'string' ? users[username] : null;
            users[username] = { password_hash: oldHash };
        }

        users[username].mfa_secret = secret;
        users[username].mfa_enabled = true;

        await writeUsers(users);
        delete req.session.tempMfaSecret;

        logger.info(`MFA abilitato con successo per ${username}`);
        res.json({ success: true, message: 'MFA abilitato correttamente.' });
    } else {
        res.status(400).json({ message: 'Codice OTP non valido. Riprova.' });
    }
});

app.post('/api/logout', (req, res) => {
    logger.info(`Logout effettuato: ${req.session.userId}`);
    req.session.destroy();
    res.json({ success: true });
});

// -----------------------------
// Homepage e Rotte Protette
// -----------------------------

// Homepage spostata in fondo al file per includere il precaricamento chat

// -----------------------------
// Endpoint Profile Utente
// -----------------------------
app.get('/api/user-profile', async (req, res) => {
    try {
        const auth = await authorize();
        if (!auth) return res.status(401).send('Autenticazione fallita.');
        const gmail = google.gmail({ version: 'v1', auth });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        res.json({ email: profile.data.emailAddress });
    } catch (error) {
        logger.error('Errore recupero profilo utente:', error);
        res.status(500).send('Errore recupero profilo.');
    }
});

// Proteggi tutte le altre API
app.use('/api', isAuthenticated);

// I seguenti endpoint sono ora automaticamente protetti perché montati sotto /api

app.get('/api/classifier-health', async (req, res) => {
    try {
        const response = await axios.get('https://localhost:5001/api/health', {
            httpsAgent: httpsAgent,
            timeout: 5000
        });
        res.json(response.data);
    } catch (error) {
        logger.error('Errore proxy health check:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.get('/api/emails', async (req, res) => {
    // Trigger syncRedmineTickets in background for "instant" processing of Cloud Monitor emails
    syncRedmineTickets().catch(err => logger.error('Background syncRedmineTickets error:', err));

    const limit = parseInt(req.query.limit, 10);
    const maxResults = !isNaN(limit) && limit > 0 ? limit : 50;

    try {
        const auth = await authorize();

        if (!auth) {
            return res.status(401).send('Autenticazione fallita.');
        }

        const gmail = google.gmail({ version: 'v1', auth });

        // Recupera l'email dell'account autenticato
        const profileRes = await gmail.users.getProfile({ userId: 'me' });
        const accountEmail = profileRes.data.emailAddress;

        const gmailRes = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread OR (from:"Cloud Monitor" after:1d)',
            maxResults: maxResults,
        });

        const messages = gmailRes.data.messages || [];

        if (messages.length === 0) {
            return res.json({ emails: [], labelMap: {} });
        }

        // Recupera tutte le etichette per mappare gli ID ai nomi leggibili
        const labelsRes = await gmail.users.labels.list({ userId: 'me' });
        const labelMap = {};
        if (labelsRes.data.labels) {
            labelsRes.data.labels.forEach(lb => {
                labelMap[lb.id] = lb.name;
            });
        }

        const emailCache = await readEmailCache();
        const cachedEmailIds = new Set(Object.keys(emailCache));
        const emails = [];
        const messagesToFetch = messages.filter(m => !cachedEmailIds.has(m.id));

        // Add cached emails to the list
        for (const message of messages) {
            if (cachedEmailIds.has(message.id)) {
                logger.debug(`Email ${message.id} trovata in cache.`);
                emails.push(emailCache[message.id]);
            }
        }

        // Process new emails in chunks to avoid overwhelming the server/network
        const CONCURRENCY_LIMIT = 20;
        for (let i = 0; i < messagesToFetch.length; i += CONCURRENCY_LIMIT) {
            const chunk = messagesToFetch.slice(i, i + CONCURRENCY_LIMIT);
            await Promise.all(chunk.map(async (message) => {
                const emailId = message.id;
                try {
                    const emailRes = await gmail.users.messages.get({ userId: 'me', id: emailId, format: 'full' });
                    const { payload, id, threadId, snippet, internalDate, labelIds } = emailRes.data;
                    const headers = payload.headers;
                    const subject = headers.find(h => h.name === 'Subject')?.value || 'Nessun Oggetto';
                    const from = headers.find(h => h.name === 'From')?.value || 'Mittente sconosciuto';

                    let body = '';
                    let bodyHtml = '';
                    const partsToProcess = [payload];
                    while (partsToProcess.length) {
                        const part = partsToProcess.shift();
                        if (part.parts) partsToProcess.push(...part.parts);
                        if (!body && part.mimeType === 'text/plain' && part.body.data) {
                            body = Buffer.from(part.body.data, 'base64').toString('utf8');
                        }
                        if (!bodyHtml && part.mimeType === 'text/html' && part.body.data) {
                            bodyHtml = Buffer.from(part.body.data, 'base64').toString('utf8');
                        }
                    }

                    if (bodyHtml && !body) {
                        body = bodyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                    }

                    if (body.length > 9000) body = body.substring(0, 9000);
                    if (bodyHtml.length > 20000) bodyHtml = bodyHtml.substring(0, 20000);

                    const emailText = `${subject} ${body}`;
                    let category = null;

                    // --- Rule-Based Classification by Gmail Labels ---
                    const emailLabelNames = (labelIds || []).map(id => labelMap[id] || id);
                    if (emailLabelNames.includes('it-support')) {
                        category = 'Human';
                        logger.debug(`Email ${id} classificata come Human tramite etichetta IT SUPPORT.`);
                    } else if (emailLabelNames.some(name => ['Backup', 'CONTROLLARE', 'SII-CMK', 'XG', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'CATEGORY_PROMOTIONS'].includes(name))) {
                        category = 'Bot';
                        logger.debug(`Email ${id} classificata come Bot tramite etichetta predefinita.`);
                    }

                    if (!category) {
                        try {
                            const classificationRes = await axios.post(CLASSIFICATION_API_URL, { text: emailText }, { httpsAgent: httpsAgent });
                            category = classificationRes.data.category || 'Bot';
                        } catch (err) {
                            logger.error(`Classificazione fallita per ${id}: ${err.message}`);
                            category = 'Bot'; // Fallback
                        }
                    }

                    const processedEmail = { id, threadId, subject, from, snippet, body, bodyHtml, score: 0.5, category, internalDate, labelIds };

                    // --- Immediate ticket association for Cloud Monitor ---
                    if (from.includes('Cloud Monitor')) {

                        const isRecovery = /CRIT\s*->\s*OK|WARN\s*->\s*OK|DOWN\s*->\s*UP/i.test(emailText);
                        if (!isRecovery) {
                            await associateRedmineTicket(processedEmail);
                        }



                        // Automark as read in Gmail
                        if (processedEmail.labelIds && processedEmail.labelIds.includes('UNREAD')) {
                            try {
                                await gmail.users.messages.modify({
                                    userId: 'me',
                                    id: processedEmail.id,
                                    requestBody: { removeLabelIds: ['UNREAD'] }
                                });
                                logger.info(`Email Cloud Monitor ${processedEmail.id} marcata come letta.`);
                                // Update labelIds in processedEmail too to reflect state in UI/cache
                                processedEmail.labelIds = processedEmail.labelIds.filter(lid => lid !== 'UNREAD');
                            } catch (readErr) {
                                logger.error(`Errore marcando come letta email Cloud Monitor ${processedEmail.id}: ${readErr.message}`);
                            }
                        }
                    }

                    emailCache[id] = processedEmail;
                    emails.push(processedEmail);
                } catch (err) {
                    logger.error(`Errore caricamento email ${emailId}: ${err.message}`);
                }
            }));
        }

        await writeEmailCache(emailCache);

        const allEmailNotes = await readEmailNotes();
        const enrichedEmails = emails.map(e => ({
            ...e,
            hasNotes: !!(allEmailNotes[e.id] && allEmailNotes[e.id].length > 0)
        }));

        res.json({ emails: enrichedEmails, labelMap, accountEmail });

    } catch (error) {
        logger.error(`Errore nel recupero delle email: ${error}`);
        res.status(500).send('Errore nel recupero delle email.');
    }
});

// -----------------------------
// Endpoint per contrassegnare email come lette (batching efficiente)
// -----------------------------
app.post('/api/mark-as-read', async (req, res) => {
    const { emailIds } = req.body; // Si aspetta un array di ID email
    logger.info(`Richiesta ricevuta per contrassegnare ${emailIds?.length || 0} email come lette.`);

    if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
        return res.status(400).send('Array emailIds non valido o vuoto.');
    }

    try {
        const auth = await authorize();
        if (!auth) {
            logger.error('Autenticazione fallita durante il processo mark-as-read.');
            return res.status(401).send('Autenticazione fallita.');
        }

        const gmail = google.gmail({ version: 'v1', auth });
        const chunkSize = 1000; // Limite batchModify Gmail API
        const chunks = [];
        for (let i = 0; i < emailIds.length; i += chunkSize) {
            chunks.push(emailIds.slice(i, i + chunkSize));
        }

        // Processa ogni chunk
        for (const chunk of chunks) {
            await gmail.users.messages.batchModify({
                userId: 'me',
                requestBody: {
                    ids: chunk,
                    removeLabelIds: ['UNREAD']
                }
            });
            logger.info(`Batch di ${chunk.length} email contrassegnate come lette.`);
        }

        res.json({ message: `Contrassegnate con successo ${emailIds.length} email come lette.` });

    } catch (error) {
        logger.error('Errore nell’endpoint batch mark-as-read:', error);
        const errorMessage = error.response?.data?.error?.message || error.message;
        res.status(500).send(`Errore nel processo mark-as-read: ${errorMessage}`);
    }
});

// -----------------------------
// Endpoint per la valutazione dell'importanza con Gemini
// -----------------------------
app.post('/api/evaluate-importance', async (req, res) => {
    const { apiKey, emailIds } = req.body;

    if (!apiKey || !emailIds || !Array.isArray(emailIds)) {
        return res.status(400).send('API Key o emailIds mancanti/richiesti.');
    }

    try {
        const emailCache = await readEmailCache();
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "gemini-3.1-flash-lite-preview",
            generationConfig: { responseMimeType: "application/json" }
        });

        // Prepara i dati per Gemini (batch di email)
        const emailsToEvaluate = emailIds
            .filter(id => emailCache[id])
            .map(id => ({
                id: id,
                subject: emailCache[id].subject,
                from: emailCache[id].from,
                snippet: emailCache[id].snippet,
            }));

        const prompt = `Analizza le seguenti email e assegna a ciascuna un punteggio di importanza da 0.0 a 1.0 (0.0 = inutile/spam, 1.0 = molto importante/urgente). 
        Restituisci solo un oggetto JSON dove la chiave è l'ID dell'email e il valore è il punteggio numerico.
        
        Emails: ${JSON.stringify(emailsToEvaluate)}`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const scores = JSON.parse(responseText);

        // Aggiorna la cache con i nuovi punteggi
        for (const [id, score] of Object.entries(scores)) {
            if (emailCache[id]) {
                emailCache[id].score = parseFloat(score);
            }
        }

        await writeEmailCache(emailCache);
        logger.info(`Importanza ri-valutata per ${Object.keys(scores).length} email con Gemini.`);

        // Restituisci le email aggiornate
        const updatedEmails = emailIds.map(id => emailCache[id]).filter(e => e);
        res.json({ message: "Valutazione completata con successo.", emails: updatedEmails });

    } catch (error) {
        logger.error('Errore durante la valutazione con Gemini:', error);
        res.status(500).send(`Errore Gemini: ${error.message}`);
    }
});

// -----------------------------
// Endpoint per riclassificare un'email e salvare i dati per il training
// -----------------------------
app.post('/api/reclassify', async (req, res) => {
    const { email, newCategory } = req.body;

    if (!email || !newCategory) {
        return res.status(400).send('Dati mancanti: sono richiesti email e newCategory.');
    }

    try {
        // 1. Estrai testo dall'oggetto email
        const text = `${email.subject} ${email.body}`.replace(/\n/g, ' ').replace(/\r/g, ' ');

        // 2. Crea una riga CSV
        // Pulisce e formatta il testo per il CSV, gestendo le virgolette
        // Pulisce e formatta il testo per il CSV, gestendo le virgolette
        const cleanText = `"${text.replace(/"/g, '""')}"`;
        const row = `${cleanText},${newCategory}\n`;

        // 3. Aggiungi al file llm_training_data.csv
        const fileExists = await fs.access(LLM_TRAINING_DATA_PATH).then(() => true).catch(() => false);
        if (!fileExists) {
            // 4. Se il file non esiste, crea e aggiungi l'header
            await fs.writeFile(LLM_TRAINING_DATA_PATH, 'text,category\n');
        }

        await fs.appendFile(LLM_TRAINING_DATA_PATH, row);

        logger.info(`Email riclassificata e aggiunta a ${LLM_TRAINING_DATA_PATH}`);
        res.status(200).json({ message: 'Email riclassificata con successo.' });

    } catch (error) {
        logger.error('Errore durante la riclassificazione dell\'email:', error);
        res.status(500).send('Errore interno del server durante la riclassificazione.');
    }
});

// -----------------------------
// Endpoint Redmine
// -----------------------------

app.get('/api/redmine/projects', async (req, res) => {
    try {
        const url = REDMINE_URL.replace('/issues.json', '/projects.json?limit=100');
        const response = await axios.get(url, {
            headers: { 'X-Redmine-API-Key': REDMINE_API_KEY },
            httpsAgent: redmineHttpsAgent
        });
        res.json(response.data.projects || []);
    } catch (error) {
        logger.error('Errore recupero progetti Redmine:', error.message);
        res.status(500).send('Errore recupero progetti Redmine.');
    }
});

app.get('/api/redmine/members/:projectId', async (req, res) => {
    const projectId = req.params.projectId;
    try {
        const url = REDMINE_URL.replace('/issues.json', `/projects/${projectId}/memberships.json?limit=100`);
        const response = await axios.get(url, {
            headers: { 'X-Redmine-API-Key': REDMINE_API_KEY },
            httpsAgent: redmineHttpsAgent
        });
        const members = (response.data.memberships || []).map(m => m.user).filter(u => u);
        res.json(members);
    } catch (error) {
        logger.error(`Errore recupero membri progetto Redmine ${projectId}:`, error.message);
        res.status(500).send('Errore recupero membri progetto Redmine.');
    }
});

app.get('/api/redmine/issues', async (req, res) => {
    try {
        // Fetch up to 100 issues for project 7291. 
        // We use status_id=* to include both open and closed if needed, 
        // but typically we'll want 'open' for monitoring.
        const url = `${REDMINE_URL}?project_id=${REDMINE_PROJECT_ID}&limit=100&sort=created_on:desc`;
        const response = await axios.get(url, {
            headers: { 'X-Redmine-API-Key': REDMINE_API_KEY },
            httpsAgent: redmineHttpsAgent
        });
        res.json(response.data.issues || []);
    } catch (error) {
        logger.error('Errore recupero issues Redmine:', error.message);
        res.status(500).send('Errore recupero issues Redmine.');
    }
});

app.post('/api/redmine/create-ticket', async (req, res) => {
    const { emailId, subject, description, priorityId, assignedToId } = req.body;
    const projectId = parseInt(req.body.projectId, 10);

    if (isNaN(projectId) || !subject || !description) {
        logger.warn('Dati incompleti o non validi per la creazione del ticket Redmine:', { projectId: req.body.projectId, subject, description });
        return res.status(400).send('Dati incompleti o non validi per la creazione del ticket.');
    }

    try {
        const issueData = {
            issue: {
                project_id: projectId,
                subject: subject,
                description: description,
                tracker_id: 1,
                status_id: 1,
                priority_id: priorityId || 2,
                assigned_to_id: assignedToId || 4
            }
        };

        const response = await axios.post(REDMINE_URL, issueData, {
            headers: {
                'X-Redmine-API-Key': REDMINE_API_KEY,
                'Content-Type': 'application/json'
            },
            httpsAgent: redmineHttpsAgent
        });

        if (response.data && response.data.issue) {
            const ticketId = response.data.issue.id;

            // Segna come letta su Gmail se emailId è fornito
            if (emailId) {
                const auth = await authorize();
                if (auth) {
                    const gmail = google.gmail({ version: 'v1', auth });
                    await gmail.users.messages.batchModify({
                        userId: 'me',
                        requestBody: { ids: [emailId], removeLabelIds: ['UNREAD'] }
                    });

                    // Aggiorna cache
                    const emailCache = await readEmailCache();
                    if (emailCache[emailId]) {
                        emailCache[emailId].redmineTicketId = ticketId;
                        await writeEmailCache(emailCache);
                    }
                }
            }

            return res.json({ success: true, ticketId });
        }
    } catch (error) {
        logger.error(`Errore creazione manuale ticket Redmine per email ${emailId || 'unknown'}:`, {
            status: error.response ? error.response.status : 'N/A',
            data: error.response ? error.response.data : error.message
        });

        const errorDetail = error.response ? {
            status: error.response.status,
            data: error.response.data
        } : error.message;

        res.status(500).json({
            message: 'Errore durante la creazione del ticket Redmine.',
            detail: errorDetail
        });
    }
});

app.post('/api/redmine/close-ticket', async (req, res) => {
    const { ticketId, emailId } = req.body;

    if (!ticketId) {
        return res.status(400).send('ticketId mancante.');
    }

    try {
        const issueData = {
            issue: {
                status_id: 5, // 5: Chiuso
                notes: 'Ticket chiuso manualmente dall\'interfaccia MaeSkimmer.'
            }
        };

        const singleTicketUrl = REDMINE_URL.replace('.json', `/${ticketId}.json`);
        await axios.put(singleTicketUrl, issueData, {
            headers: {
                'X-Redmine-API-Key': REDMINE_API_KEY,
                'Content-Type': 'application/json'
            },
            httpsAgent: redmineHttpsAgent,
            timeout: 10000
        });

        logger.info(`Ticket Redmine ${ticketId} chiuso manualmente.`);

        // Aggiorna la cache se emailId è fornito
        if (emailId) {
            const emailCache = await readEmailCache();
            if (emailCache[emailId]) {
                emailCache[emailId].redmineTicketStatus = 'Resolved';
                await writeEmailCache(emailCache);
            }
        }

        res.json({ success: true, message: `Ticket ${ticketId} chiuso con successo.` });
    } catch (error) {
        logger.error(`Errore durante la chiusura del ticket Redmine ${ticketId}:`, error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).send('Errore durante la chiusura del ticket.');
    }
});

app.post('/api/send-ticket-notification', async (req, res) => {
    const { to, subject, body, threadId } = req.body;

    if (!to || !subject || !body) {
        return res.status(400).json({ message: 'Dati mancanti: to, subject e body sono obbligatori.' });
    }

    try {
        const auth = await authorize();
        if (!auth) {
            return res.status(401).json({ message: 'Autenticazione Gmail fallita o non configurata.' });
        }
        const gmail = google.gmail({ version: 'v1', auth });

        // Helper per codifica base64url richiesta da Gmail API
        const base64url = (str) => {
            return Buffer.from(str).toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');
        };

        const recipients = to.split(/[;,]/).map(email => email.trim()).filter(email => email !== '');
        
        // Costruzione del messaggio RFC822
        const emailLines = [
            `To: ${recipients.join(', ')}`,
            `Subject: ${subject}`,
            'Content-Type: text/html; charset=utf-8',
            'MIME-Version: 1.0',
            '',
            body
        ];

        const raw = base64url(emailLines.join('\r\n'));

        await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: raw,
                threadId: threadId || undefined
            }
        });

        logger.info(`Notifica ticket inviata via Gmail API a: ${recipients.join(', ')}`);
        res.json({ success: true, message: 'Notifica inviata con successo via Gmail.' });

    } catch (error) {
        logger.error('Errore durante l\'invio della notifica via Gmail API:', error);
        
        let message = 'Errore durante l\'invio dell\'email via Gmail.';
        if (error.message.includes('insufficient permissions') || (error.response && error.response.status === 403)) {
            message = 'Permessi Gmail insufficienti per inviare. È necessario ri-autorizzare l\'app (node generate_token.js).';
        }

        res.status(500).json({ 
            message: message, 
            error: error.message 
        });
    }
});


// -----------------------------
// Endpoint Google Chat
// -----------------------------

app.get('/api/chat/spaces', async (req, res) => {
    try {
        const auth = await authorize();
        if (!auth) return res.status(401).send('Autenticazione fallita.');
        const chat = google.chat({ version: 'v1', auth });
        const people = google.people({ version: 'v1', auth });

        // Get my own profile to know my user ID
        let myId = '';
        try {
            const myProfile = await people.people.get({ resourceName: 'people/me', personFields: 'names' });
            myId = myProfile.data.resourceName.replace('people/', 'users/');
        } catch (e) {
            logger.warn('Impossibile ottenere il profilo utente tramite People API:', e.message);
        }

        // Elenca gli spazi (Direct Messages e Group Chats)
        const response = await chat.spaces.list({
            pageSize: 100
        });

        let spaces = response.data.spaces || [];

        // Risolviamo i nomi per i DM se vuoti (solo per i primi 20 per evitare timeout/rate limit)
        const spacesToResolve = spaces.filter(s => s.spaceType === 'DIRECT_MESSAGE' && !s.displayName).slice(0, 20);

        for (let space of spacesToResolve) {
            try {
                const membersRes = await chat.spaces.members.list({ parent: space.name });
                const members = membersRes.data.memberships || [];
                // Cerchiamo il membro che non sia un bot e che non sia io
                const otherMember = members.find(m => m.member && m.member.type === 'HUMAN' && m.member.name !== myId);
                if (otherMember) {
                    try {
                        const personName = otherMember.member.name.replace('users/', 'people/');
                        const personRes = await people.people.get({ resourceName: personName, personFields: 'names' });
                        if (personRes.data.names && personRes.data.names.length > 0) {
                            space.displayName = personRes.data.names[0].displayName;
                        }
                    } catch (peopleError) {
                        logger.warn(`Errore Google People API per ${otherMember.member.name}:`, peopleError.message);
                    }
                }
            } catch (e) {
                logger.warn(`Errore risoluzione nome DM per ${space.name}:`, e.message);
            }
        }

        res.json({ spaces, myId });
    } catch (error) {
        logger.error('Errore recupero spazi Google Chat:', error.message);
        res.status(500).send('Errore recupero spazi Google Chat.');
    }
});

app.get('/api/chat/messages/:spaceId', async (req, res) => {
    const { spaceId } = req.params;
    try {
        const auth = await authorize();
        if (!auth) return res.status(401).send('Autenticazione fallita.');
        const chat = google.chat({ version: 'v1', auth });
        const people = google.people({ version: 'v1', auth });

        const response = await chat.spaces.messages.list({
            parent: `spaces/${spaceId}`,
            pageSize: 50,
            orderBy: 'createTime desc'
        });

        // Otteniamo i membri dello spazio per risolvere i nomi e "isMine"
        let membersMap = {};
        try {
            const membersRes = await chat.spaces.members.list({
                parent: `spaces/${spaceId}`
            });
            const memberships = membersRes.data.memberships || [];

            // Raccogli i resourceNames per la chiamata batch (massimo 50 per chiamata)
            const humanResourceNames = memberships
                .filter(m => m.member && m.member.type === 'HUMAN')
                .map(m => m.member.name.replace('users/', 'people/'))
                .slice(0, 50);

            if (humanResourceNames.length > 0) {
                try {
                    const batchRes = await people.people.getBatchGet({
                        resourceNames: humanResourceNames,
                        personFields: 'names'
                    });

                    if (batchRes.data.responses) {
                        batchRes.data.responses.forEach(r => {
                            if (r.person && r.person.names && r.person.names.length > 0) {
                                const userId = r.requestedResourceName.replace('people/', 'users/');
                                membersMap[userId] = r.person.names[0].displayName;
                            }
                        });
                    }
                } catch (batchErr) {
                    logger.warn('Errore recupero nomi membri tramite People API in batch:', batchErr.message);
                }
            }

            // Aggiungi nomi di default per i bot o fallback
            memberships.forEach(m => {
                if (m.member && !membersMap[m.member.name]) {
                    membersMap[m.member.name] = m.member.displayName || (m.member.type === 'BOT' ? 'Bot' : 'Unknown');
                }
            });

        } catch (e) {
            logger.warn(`Non è stato possibile recuperare i membri per lo spazio ${spaceId}:`, e.message);
        }

        res.json({
            messages: response.data.messages || [],
            membersMap
        });
    } catch (error) {
        logger.error(`Errore recupero messaggi per lo spazio ${spaceId}:`, error.message);
        res.status(500).send('Errore recupero messaggi Google Chat.');
    }
});

app.post('/api/chat/send', async (req, res) => {
    const { spaceId, text } = req.body;
    if (!spaceId || !text) {
        return res.status(400).send('spaceId e text sono obbligatori.');
    }

    try {
        const auth = await authorize();
        if (!auth) return res.status(401).send('Autenticazione fallita.');
        const chat = google.chat({ version: 'v1', auth });

        const response = await chat.spaces.messages.create({
            parent: `spaces/${spaceId}`,
            requestBody: {
                text: text
            }
        });

        res.json(response.data);
    } catch (error) {
        logger.error(`Errore invio messaggio allo spazio ${spaceId}:`, error.message);
        res.status(500).send('Errore invio messaggio Google Chat.');
    }
});

app.get(/^\/api\/chat\/media\/(.+)/, async (req, res) => {
    const resourceName = req.params[0];
    logger.info(`Richiesta download media per: ${resourceName}`);
    if (!resourceName) {
        return res.status(400).send('Resource name is required.');
    }

    try {
        const auth = await authorize();
        if (!auth) return res.status(401).send('Autenticazione fallita.');
        const chat = google.chat({ version: 'v1', auth });

        // Pipe the media stream directly to the response
        const response = await chat.media.download({
            resourceName: resourceName,
            alt: 'media'
        }, {
            responseType: 'stream'
        });

        // Pass headers from the API response
        if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
        if (response.headers['content-disposition']) res.setHeader('Content-Disposition', response.headers['content-disposition']);

        response.data.pipe(res);
    } catch (error) {
        logger.error(`Errore download media ${resourceName}: ${error.message}`, {
            status: error.response?.status,
            data: error.response?.data
        });
        res.status(500).send('Errore download media.');
    }
});


const NOTES_PATH = path.join(__dirname, 'notes.json');
const EMAIL_NOTES_PATH = path.join(__dirname, 'email_notes.json');

// --- Email Notes Helpers ---
async function readEmailNotes() {
    try {
        const data = await fs.readFile(EMAIL_NOTES_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        logger.error('Errore lettura email_notes.json:', error);
        return {};
    }
}

async function writeEmailNotes(notes) {
    try {
        await fs.writeFile(EMAIL_NOTES_PATH, JSON.stringify(notes, null, 2), 'utf8');
    } catch (error) {
        logger.error('Errore scrittura email_notes.json:', error);
    }
}

// Funzione per leggere le note dal file
async function readNotes() {
    try {
        const data = await fs.readFile(NOTES_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return []; // Ritorna array vuoto se il file non esiste
        }
        logger.error('Errore nella lettura del file note:', error);
        return [];
    }
}

// Funzione per scrivere le note nel file
async function writeNotes(notes) {
    try {
        await fs.writeFile(NOTES_PATH, JSON.stringify(notes, null, 2), 'utf8');
    } catch (error) {
        logger.error('Errore nella scrittura del file note:', error);
    }
}

// Ottieni tutte le note
app.get('/api/notes', async (req, res) => {
    const notes = await readNotes();
    res.json(notes);
});

// Crea una nuova nota
app.post('/api/notes', async (req, res) => {
    const { title, content } = req.body;
    if (!title) {
        return res.status(400).json({ message: 'Il titolo è obbligatorio.' });
    }
    const notes = await readNotes();
    const newNote = {
        id: Date.now().toString(),
        title,
        content: content || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    notes.push(newNote);
    await writeNotes(notes);
    res.status(201).json(newNote);
});

// Aggiorna una nota
app.put('/api/notes/:id', async (req, res) => {
    const { id } = req.params;
    const { title, content } = req.body;
    const notes = await readNotes();
    const noteIndex = notes.findIndex(note => note.id === id);

    if (noteIndex === -1) {
        return res.status(404).json({ message: 'Nota non trovata.' });
    }

    notes[noteIndex] = {
        ...notes[noteIndex],
        title: title !== undefined ? title : notes[noteIndex].title,
        content: content !== undefined ? content : notes[noteIndex].content,
        updatedAt: new Date().toISOString(),
    };

    await writeNotes(notes);
    res.json(notes[noteIndex]);
});

// Elimina una nota
app.delete('/api/notes/:id', async (req, res) => {
    const { id } = req.params;
    const notes = await readNotes();
    const filteredNotes = notes.filter(note => note.id !== id);

    if (notes.length === filteredNotes.length) {
        return res.status(404).json({ message: 'Nota non trovata.' });
    }

    await writeNotes(filteredNotes);
    res.status(204).send();
});

// --- Email Notes Endpoints ---
app.get('/api/email-notes/:emailId', async (req, res) => {
    const { emailId } = req.params;
    const allNotes = await readEmailNotes();
    const emailNotes = allNotes[emailId] || [];
    res.json(emailNotes);
});

app.post('/api/email-notes', async (req, res) => {
    const { emailId, content, parentId } = req.body;
    const userId = req.session.userId || 'unknown';

    if (!emailId || !content) {
        return res.status(400).json({ message: 'emailId e content sono obbligatori.' });
    }

    const allNotes = await readEmailNotes();
    if (!allNotes[emailId]) {
        allNotes[emailId] = [];
    }

    const newNote = {
        id: Date.now().toString(),
        userId,
        content,
        parentId: parentId || null,
        createdAt: new Date().toISOString()
    };

    allNotes[emailId].push(newNote);
    await writeEmailNotes(allNotes);

    res.status(201).json(newNote);
});

// -----------------------------
// Endpoint per i log
// -----------------------------

// Endpoint per elencare tutti i file di log
app.get('/api/logs', async (req, res) => {
    const logsRoot = path.join(__dirname, 'logs');
    try {
        const folders = await fs.readdir(logsRoot);
        const logFiles = [];
        for (const folder of folders) {
            const folderPath = path.join(logsRoot, folder);
            const stat = await fs.stat(folderPath);
            if (stat.isDirectory()) {
                const files = await fs.readdir(folderPath);
                files.forEach(file => {
                    logFiles.push(`${folder}/${file}`);
                });
            }
        }
        res.json(logFiles);
    } catch (error) {
        logger.error('Errore nell’elenco dei file di log:', error);
        res.status(500).send('Errore nell’elenco dei file di log.');
    }
});

// Endpoint per ottenere un file di log specifico
app.get('/api/logs/:folder/:file', (req, res) => {
    const { folder, file } = req.params;
    const logPath = path.join(__dirname, 'logs', folder, file);

    // Controllo sicurezza
    const logsDir = path.resolve(path.join(__dirname, 'logs'));
    const requestedPath = path.resolve(logPath);
    if (!requestedPath.startsWith(logsDir)) {
        return res.status(403).send('Proibito');
    }

    const fileStream = fsSync.createReadStream(logPath);

    fileStream.on('error', (err) => {
        logger.error(`Errore nella lettura di ${logPath}:`, err);
        if (!res.headersSent) {
            if (err.code === 'ENOENT') {
                res.status(404).send('File di log non trovato.');
            } else {
                res.status(500).send('Errore nella lettura del file di log.');
            }
        }
    });

    const rl = require('readline').createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    if (req.query.meta === 'true') {
        let lineCount = 0;
        rl.on('line', () => {
            lineCount++;
        });
        rl.on('close', () => {
            if (!res.headersSent) {
                res.json({ totalLines: lineCount });
            }
        });
    } else {
        const offset = parseInt(req.query.offset, 10) || 0;
        const limit = parseInt(req.query.limit, 10) || 100;
        let lines = [];
        let currentLine = 0;

        rl.on('line', (line) => {
            if (currentLine >= offset && currentLine < offset + limit) {
                lines.push(line);
            }
            currentLine++;
        });

        rl.on('close', () => {
            if (!res.headersSent) {
                res.set('Content-Type', 'text/plain');
                res.send(lines.join('\n'));
            }
        });
    }
});

async function getPreloadedChatData(auth) {
    if (!auth) return null;
    try {
        const chat = google.chat({ version: 'v1', auth });
        const people = google.people({ version: 'v1', auth });

        // Get my own profile to know my user ID
        let myId = '';
        try {
            const myProfile = await people.people.get({ resourceName: 'people/me', personFields: 'names' });
            myId = myProfile.data.resourceName.replace('people/', 'users/');
        } catch (e) {
            logger.warn('Preload: Impossibile ottenere il profilo utente:', e.message);
        }

        // Elenca gli spazi (Direct Messages e Group Chats)
        const response = await chat.spaces.list({ pageSize: 20 });
        let spaces = response.data.spaces || [];

        // Risolviamo i nomi per i DM (limitato per velocità)
        const dmSpaces = spaces.filter(s => s.spaceType === 'DIRECT_MESSAGE' && !s.displayName).slice(0, 10);
        for (let space of dmSpaces) {
            try {
                const membersRes = await chat.spaces.members.list({ parent: space.name });
                const members = membersRes.data.memberships || [];
                const otherMember = members.find(m => m.member && m.member.type === 'HUMAN' && m.member.name !== myId);
                if (otherMember) {
                    try {
                        const personName = otherMember.member.name.replace('users/', 'people/');
                        const personRes = await people.people.get({ resourceName: personName, personFields: 'names' });
                        if (personRes.data.names && personRes.data.names.length > 0) {
                            space.displayName = personRes.data.names[0].displayName;
                        }
                    } catch (pe) { }
                }
            } catch (e) { }
        }

        // Recupera i messaggi iniziali per i primi 3 spazi più recenti
        const initialMessages = {};
        const membersMapMap = {}; // spaceId -> membersMap
        const spacesToFetchMsgs = spaces.slice(0, 3);

        for (const space of spacesToFetchMsgs) {
            const spaceId = space.name.split('/')[1];
            try {
                const msgsRes = await chat.spaces.messages.list({
                    parent: space.name,
                    pageSize: 30,
                    orderBy: 'createTime desc'
                });
                initialMessages[spaceId] = msgsRes.data.messages || [];

                // Risoluzione membri minima per lo spazio
                const membersRes = await chat.spaces.members.list({ parent: space.name });
                const mMap = {};
                (membersRes.data.memberships || []).forEach(m => {
                    if (m.member) mMap[m.member.name] = m.member.displayName || 'Unknown';
                });
                membersMapMap[spaceId] = mMap;
            } catch (e) {
                logger.warn(`Preload: Errore messaggi per ${spaceId}:`, e.message);
            }
        }

        return { spaces, initialMessages, membersMapMap, myId };
    } catch (error) {
        logger.error('Preload: Errore generale precaricamento chat:', error.message);
        return null;
    }
}

// -----------------------------
// Homepage
// -----------------------------

app.get('/', isAuthenticated, async (req, res) => {
    try {
        const auth = await authorize();
        const preloadedChat = await getPreloadedChatData(auth);

        const indexPath = path.join(__dirname, 'public', 'index.html');
        let html = await fs.readFile(indexPath, 'utf8');

        // Iniettiamo i dati precaricati prima della chiusura del body
        if (preloadedChat) {
            const preloadScript = `
    <script>
        window.__PRELOADED_CHAT__ = ${JSON.stringify(preloadedChat)};
        console.log('Chat precaricata caricata con successo.');
    </script>
`;
            html = html.replace('</body>', preloadScript + '</body>');
        }

        res.setHeader('Content-Security-Policy', "default-src 'self' https: 'unsafe-inline' 'unsafe-eval' data:; connect-src 'self' https:; frame-src 'self' https://calendar.google.com/ https://mail.google.com/;");
        res.send(html);
    } catch (error) {
        logger.error('Errore durante il caricamento della homepage:', error);
        res.status(500).send('Errore interno del server.');
    }
});

// -----------------------------
// Server HTTPS e redirect HTTP
// -----------------------------

const options = {
    key: fsSync.readFileSync(path.join(__dirname, 'certs/key.pem')),
    cert: fsSync.readFileSync(path.join(__dirname, 'certs/cert.pem')),
};

const httpsServer = https.createServer(options, app);

// Gestore errori globale
app.use((err, req, res, next) => {
    logger.error('Errore non gestito:', err);
    if (res.headersSent) {
        return next(err);
    }
    const acceptHeader = req.headers.accept || '';
    if (req.xhr || acceptHeader.includes('application/json')) {
        res.status(500).json({
            message: 'Si è verificato un errore interno del server.',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    } else {
        res.status(500).send('Si è verificato un errore interno del server.');
    }
});

httpsServer.listen(httpsPort, () => {
    logger.info(`Server HTTPS in ascolto sulla porta ${httpsPort}`);
});

const httpServer = http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
});

httpServer.listen(port, () => {
    logger.info(`Server HTTP in ascolto sulla porta ${port} e redireziona su HTTPS`);
});
