const axios = require('axios');
const https = require('https');

const REDMINE_URL = 'https://projects.maestrale.it/issue_statuses.json';
const API_KEY = '6c82584b1a055fa3fb9e807c80fd3666174ca79f';

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

async function listStatuses() {
    try {
        const response = await axios.get(REDMINE_URL, {
            headers: { 'X-Redmine-API-Key': API_KEY },
            httpsAgent: httpsAgent
        });

        console.log('Available Statuses:');
        response.data.issue_statuses.forEach(status => {
            console.log(`ID: ${status.id}, Name: ${status.name}, is_closed: ${status.is_closed}`);
        });
    } catch (error) {
        console.error('Error fetching statuses:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data));
        }
    }
}

listStatuses();
