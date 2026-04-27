require('dotenv').config();
const fs = require('fs').promises;
const axios = require('axios');
const https = require('https');
const path = require('path');

const REDMINE_URL = process.env.REDMINE_URL || 'https://projects.maestrale.it/issues.json';
const API_KEY = process.env.REDMINE_API_KEY || '6c82584b1a055fa3fb9e807c80fd3666174ca79f';
const PROJECT_ID = parseInt(process.env.REDMINE_PROJECT_ID, 10) || 7291;
const EMAIL_CACHE_PATH = path.join(__dirname, 'email_cache.json');

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

async function createRedmineTickets() {
    try {
        console.log('Reading email cache...');
        const data = await fs.readFile(EMAIL_CACHE_PATH, 'utf8');
        const emailCache = JSON.parse(data);

        // Filter for Cloud Monitor emails
        const cloudMonitorEmails = Object.values(emailCache).filter(email =>
            email.from && email.from.includes('Cloud Monitor')
        );

        console.log(`Found ${cloudMonitorEmails.length} emails from Cloud Monitor.`);

        for (const email of cloudMonitorEmails) {
            console.log(`Creating ticket for: ${email.subject}`);

            const issueData = {
                issue: {
                    project_id: PROJECT_ID,
                    subject: email.subject,
                    description: `Mittente: ${email.from}\n\nSnippet: ${email.snippet}\n\nCorpo:\n${email.body}`,
                    tracker_id: 1,
                    status_id: 1
                }
            };

            try {
                const response = await axios.post(REDMINE_URL, issueData, {
                    headers: {
                        'X-Redmine-API-Key': API_KEY,
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                    },
                    httpsAgent: httpsAgent,
                    timeout: 10000
                });

                if (response.data && response.data.issue) {
                    console.log(`Successfully created ticket ID: ${response.data.issue.id}`);
                }
            } catch (error) {
                console.error(`Failed to create ticket for: ${email.subject}`);
                if (error.response) {
                    console.error(`Status: ${error.response.status}`);
                    if (error.response.data && typeof error.response.data === 'object') {
                        console.error('Errors:', JSON.stringify(error.response.data.errors));
                    } else {
                        console.error('Data:', error.response.data.toString().substring(0, 200));
                    }
                } else {
                    console.error(`Error: ${error.message}`);
                }
            }
        }

        console.log('Finished processing Cloud Monitor emails.');

    } catch (error) {
        console.error('Error processing email cache:', error);
    }
}

createRedmineTickets();
