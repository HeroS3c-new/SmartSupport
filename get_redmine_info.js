const axios = require('axios');
const https = require('https');

const REDMINE_URL_PRIORITIES = 'https://projects.maestrale.it/enumerations/issue_priorities.json';
const REDMINE_URL_GROUPS = 'https://projects.maestrale.it/groups.json';
const REDMINE_URL_PROJECT_MEMBERSHIPS = 'https://projects.maestrale.it/projects/7291/memberships.json';
const API_KEY = '6c82584b1a055fa3fb9e807c80fd3666174ca79f';

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

async function run() {
    try {
        const prioritiesRes = await axios.get(REDMINE_URL_PRIORITIES, { headers: { 'X-Redmine-API-Key': API_KEY }, httpsAgent });
        console.log('--- Priorities ---');
        console.log(JSON.stringify(prioritiesRes.data, null, 2));

        const groupsRes = await axios.get(REDMINE_URL_GROUPS, { headers: { 'X-Redmine-API-Key': API_KEY }, httpsAgent });
        console.log('--- Groups ---');
        console.log(JSON.stringify(groupsRes.data, null, 2));

        const membersRes = await axios.get(REDMINE_URL_PROJECT_MEMBERSHIPS, { headers: { 'X-Redmine-API-Key': API_KEY }, httpsAgent, params: { limit: 100 } });
        console.log('--- Project Members ---');
        console.log(JSON.stringify(membersRes.data, null, 2));

    } catch (e) {
        console.error(e.message);
        if (e.response) console.error(e.response.data);
    }
}
run();
