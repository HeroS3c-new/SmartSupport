const axios = require('axios');
const https = require('https');

const REDMINE_API_KEY = '6c82584b1a055fa3fb9e807c80fd3666174ca79f';
const REDMINE_URL_PROJECTS = 'https://projects.maestrale.it/projects.json?limit=100';

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

async function listProjects() {
    try {
        const response = await axios.get(REDMINE_URL_PROJECTS, {
            headers: { 'X-Redmine-API-Key': REDMINE_API_KEY },
            httpsAgent: httpsAgent
        });
        console.log('--- Projects ---');
        response.data.projects.forEach(p => {
            console.log(`ID: ${p.id}, Identifier: ${p.identifier}, Name: ${p.name}`);
        });
    } catch (error) {
        console.error('Error listing projects:', error.message);
    }
}

listProjects();
