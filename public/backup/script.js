function showTab(tabName) {
    const humanView = document.getElementById('human-view');
    const botView = document.getElementById('bot-view');
    const pinnedView = document.getElementById('pinned-view');
    const humanTab = document.getElementById('human-tab');
    const botTab = document.getElementById('bot-tab');
    const pinnedTab = document.getElementById('show-pinned-emails'); // This ID is still used in HTML

    if (tabName === 'human') {
        humanView.style.display = 'block';
        botView.style.display = 'none';
        pinnedView.style.display = 'none';
        humanTab.classList.add('active');
        botTab.classList.remove('active');
        pinnedTab.classList.remove('active');
    } else if (tabName === 'bot') {
        humanView.style.display = 'none';
        botView.style.display = 'block';
        pinnedView.style.display = 'none';
        humanTab.classList.remove('active');
        botTab.classList.add('active');
        pinnedTab.classList.remove('active');
    } else if (tabName === 'pinned') {
        humanView.style.display = 'none';
        botView.style.display = 'none';
        pinnedView.style.display = 'block';
        humanTab.classList.remove('active');
        botTab.classList.remove('active');
        pinnedTab.classList.add('active');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const bulb = document.getElementById('lightbulb');
    const body = document.body;

    // Recupera tema salvato
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        body.classList.add('dark-mode');
        bulb.classList.add('dark');
        bulb.innerHTML = '<i class="fa-solid fa-moon"></i>';
    }

    // Al click sulla lampadina
    bulb.addEventListener('click', () => {
        body.classList.toggle('dark-mode');
        bulb.classList.toggle('dark');

        if (body.classList.contains('dark-mode')) {
            bulb.innerHTML = '<i class="fa-solid fa-moon"></i>'; // diventa luna
            localStorage.setItem('theme', 'dark');
        } else {
            bulb.innerHTML = '<i class="fa-regular fa-lightbulb"></i>'; // diventa lampadina
            localStorage.setItem('theme', 'light');
        }
    });


    const selectAllCheckbox = document.getElementById('select-all-checkbox');
    const selectCurrentTabCheckbox = document.getElementById('select-current-tab-checkbox');
    const humanEmailListContainer = document.getElementById('human-email-list-container');
    const botEmailListContainer = document.getElementById('bot-email-list-container');
    const humanHighlightedEmailsContainer = document.getElementById('human-highlighted-emails-container');
    const botHighlightedEmailsContainer = document.getElementById('bot-highlighted-emails-container');
    const humanView = document.getElementById('human-view');
    const botView = document.getElementById('bot-view');
    const sortScoreButton = document.getElementById('sort-score-button');
    const sortDateButton = document.getElementById('sort-date-button');
    const markReadButton = document.getElementById('mark-read-button');
    const loadingSpinner = document.getElementById('loading-spinner');
    const selectUselessCheckbox = document.getElementById('select-useless-checkbox');
    const emailStats = document.getElementById('email-stats');
    const emailLimitSelect = document.getElementById('email-limit');
    const autoRefreshSelect = document.getElementById('auto-refresh');
    const loadingMessage = document.getElementById('loading-message');
    const pinnedEmailsContainer = document.getElementById('pinned-emails-container');
    const pinnedView = document.getElementById('pinned-view');

    document.getElementById('human-tab').addEventListener('click', () => showTab('human'));
    document.getElementById('bot-tab').addEventListener('click', () => showTab('bot'));
    document.getElementById('show-pinned-emails').addEventListener('click', () => showTab('pinned'));

    // Gemini API Key Persistence
    const geminiApiKeyInput = document.getElementById('gemini-api-key');
    const savedApiKey = localStorage.getItem('gemini_api_key');
    if (savedApiKey) {
        geminiApiKeyInput.value = savedApiKey;
    }

    geminiApiKeyInput.addEventListener('change', (e) => {
        localStorage.setItem('gemini_api_key', e.target.value);
    });

    const evaluateImportanceBtn = document.getElementById('evaluate-importance-btn');
    evaluateImportanceBtn.addEventListener('click', () => evaluateImportanceWithGemini());

    let emails = [];
    let pinnedEmails = [];
    let refreshTimer = null;

    document.getElementById('login-button').style.display = 'none';

    selectAllCheckbox.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const allCheckboxes = document.querySelectorAll('.email-item input[type="checkbox"], .pair-box input[type="checkbox"]');
        allCheckboxes.forEach(checkbox => {
            checkbox.checked = isChecked;
            if (checkbox.closest('.pair-box')) {
                const changeEvent = new Event('change');
                checkbox.dispatchEvent(changeEvent);
            }
        });
    });

    selectCurrentTabCheckbox.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const activeTab = document.querySelector('.nav-link.active').id;
        let viewId;
        if (activeTab === 'human-tab') {
            viewId = 'human-view';
        } else if (activeTab === 'bot-tab') {
            viewId = 'bot-view';
        } else if (activeTab === 'show-pinned-emails') {
            viewId = 'pinned-view';
        }

        if (viewId) {
            const view = document.getElementById(viewId);
            const allCheckboxes = view.querySelectorAll('.email-item input[type="checkbox"], .pair-box input[type="checkbox"]');
            allCheckboxes.forEach(checkbox => {
                checkbox.checked = isChecked;
                if (checkbox.closest('.pair-box')) {
                    const changeEvent = new Event('change');
                    checkbox.dispatchEvent(changeEvent);
                }
            });
        }
    });

    selectUselessCheckbox.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const emailItems = document.querySelectorAll('.email-item');
        emailItems.forEach(item => {
            const checkbox = item.querySelector('input[type="checkbox"]');
            if (isChecked) {
                const emailId = item.dataset.id;
                const email = emails.find(e => e.id === emailId);
                const isLowScore = email && email.score <= 0.49;
                checkbox.checked = isLowScore;
            } else {
                checkbox.checked = false;
            }
        });

        // After setting individual email checkboxes, check pair-box checkboxes if any of their contained emails are selected
        const pairBoxes = document.querySelectorAll('.pair-box');
        pairBoxes.forEach(pairBox => {
            const pairCheckbox = pairBox.querySelector('.pair-checkbox');
            if (isChecked) {
                const emailIdsInGroup = pairBox.dataset.emailIds.split(',');
                const allEmailsInGroup = emails.filter(email => emailIdsInGroup.includes(email.id));
                const allAreUseless = allEmailsInGroup.every(email => email.score <= 0.49);

                pairCheckbox.checked = allAreUseless;
                // If the pair-box checkbox is checked, dispatch a change event to ensure its internal logic runs
                if (allAreUseless) {
                    const changeEvent = new Event('change');
                    pairCheckbox.dispatchEvent(changeEvent);
                }
            } else {
                pairCheckbox.checked = false;
                // Dispatch change event to uncheck all inner emails if the pairBox is unchecked
                const changeEvent = new Event('change');
                pairCheckbox.dispatchEvent(changeEvent);
            }
        });
    });

    sortScoreButton.addEventListener('click', () => {
        emails.sort((a, b) => b.score - a.score);
        rerenderEmails();
    });

    sortDateButton.addEventListener('click', () => {
        emails.sort((a, b) => b.internalDate - a.internalDate);
        rerenderEmails();
    });

    markReadButton.addEventListener('click', () => handleMarkAction('read'));



    async function handleMarkAction(action) {
        const selectedCheckboxes = document.querySelectorAll('.email-item input[type="checkbox"]:checked');
        const emailIds = Array.from(selectedCheckboxes).map(cb => cb.closest('.email-item').dataset.id);

        if (emailIds.length === 0) {
            alert(`Seleziona almeno un'email.`);
            return;
        }

        const emailsToSend = emails.filter(e => emailIds.includes(e.id));
        let endpoint, body;

        switch (action) {
            case 'read':
                endpoint = '/api/mark-as-read';
                body = { emailIds: emailIds };
                break;
            default:
                return;
        }

        // Add animation class to selected emails
        selectedCheckboxes.forEach(cb => {
            const emailItem = cb.closest('.email-item');
            if (emailItem) {
                emailItem.classList.add('marking-as-read');
            }
        });

        loadingSpinner.style.display = 'block';
        try {
            let response;
            let success = false;
            for (let i = 0; i < 3; i++) {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                if (response.ok) {
                    success = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
            }

            if (!success) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            alert(result.message || `Azione completata con successo.`);
            if (action === 'read') {
                fetchAndDisplayEmails();
            }
        } catch (error) {
            console.error(`Error marking emails as ${action}:`, error);
            alert(`Errore durante l'operazione. Controlla la console.`);
        } finally {
            loadingSpinner.style.display = 'none';
        }
    }

    async function reclassifyEmail(emailId, newCategory) {
        const email = emails.find(e => e.id === emailId);
        if (!email) return;

        try {
            const response = await fetch('/api/reclassify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, newCategory })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            email.category = newCategory;

            rerenderEmails();

        } catch (error) {
            console.error('Error reclassifying email:', error);
            alert('Errore durante la riclassificazione dell\'email. Controlla la console per i dettagli.');
        }
    }

    async function evaluateImportanceWithGemini() {
        const apiKey = document.getElementById('gemini-api-key').value;
        if (!apiKey) {
            alert("Inserisci l'API Key di Gemini.");
            return;
        }

        if (emails.length === 0) {
            alert("Nessuna email da valutare.");
            return;
        }

        const emailIds = emails.map(e => e.id);

        loadingSpinner.style.display = 'block';
        loadingMessage.style.display = 'block';
        loadingMessage.textContent = `Valutazione importanza con Gemini in corso per ${emailIds.length} email...`;

        try {
            const response = await fetch('/api/evaluate-importance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey, emailIds })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || `HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            alert(result.message);

            // Aggiorna l'array locale delle email con i nuovi punteggi
            if (result.emails) {
                result.emails.forEach(updatedEmail => {
                    const index = emails.findIndex(e => e.id === updatedEmail.id);
                    if (index !== -1) {
                        emails[index].score = updatedEmail.score;
                    }
                });
            }

            rerenderEmails();

        } catch (error) {
            console.error('Error evaluating importance with Gemini:', error);
            alert(`Errore durante la valutazione: ${error.message}`);
        } finally {
            loadingSpinner.style.display = 'none';
            loadingMessage.style.display = 'none';
            loadingMessage.textContent = '';
        }
    }

    async function fetchAndDisplayEmails() {
        loadingSpinner.style.display = 'block';
        loadingMessage.style.display = 'block';
        loadingMessage.textContent = 'Sto scaricando le email dal server...';
        humanEmailListContainer.innerHTML = '';
        botEmailListContainer.innerHTML = '';
        humanHighlightedEmailsContainer.innerHTML = '';
        botHighlightedEmailsContainer.innerHTML = '';

        const limit = emailLimitSelect.value; // Get the selected limit
        let errorOccurred = false;

        try {
            const response = await fetch(`/api/emails?limit=${limit}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            emails = data.emails;
            loadingMessage.textContent = `Scaricamento completato. Analizzando ${emails.length} email con l\'LLM...`;
            rerenderEmails();

        } catch (error) {
            console.error('Error fetching emails:', error);
            alert('Si è verificato un errore durante il recupero delle email. Controlla la console per i dettagli.');
            humanEmailListContainer.innerHTML = '<p>Errore nel reperire le email. Controlla la console per errori.</p>';
            loadingMessage.textContent = 'Errore durante il caricamento delle email.';
            errorOccurred = true;
        } finally {
            loadingSpinner.style.display = 'none';
            if (!errorOccurred) { // Only hide and clear message if no error occurred
                loadingMessage.style.display = 'none';
                loadingMessage.textContent = '';
            }
        }
    }

    function rerenderEmails() {
        const humanEmails = emails.filter(e => e.category === 'Human');
        const botEmails = emails.filter(e => e.category === 'Bot');

        emailStats.textContent = `Email non lette: ${emails.length} (Human: ${humanEmails.length}, Bot: ${botEmails.length})`

        document.getElementById('human-count').textContent = humanEmails.length;
        document.getElementById('bot-count').textContent = botEmails.length;

        displayEmails(humanEmails, humanEmailListContainer, humanHighlightedEmailsContainer, false);
        displayEmails(botEmails, botEmailListContainer, botHighlightedEmailsContainer, true);
        displayEmails(pinnedEmails, pinnedEmailsContainer, null, false);
    }

    function findEmailGroups(emailsToDisplay) {
        const groups = {};
        const processedIds = new Set();
        const problemMap = {}; // Key: problemIdentifier, Value: array of emails

        emailsToDisplay.forEach(email => {
            const subject = email.subject;
            let problemIdentifier = null;
            const states = [];

            // Regex for state changes, e.g., "host/service OK -> CRIT"
            const changeMatch = subject.match(/^(.*?)[\s\-\/]+(UP|DOWN|OK|WARN|CRIT|UNKNOWN|PENDING)\b\s*->\s*(UP|DOWN|OK|WARN|CRIT|UNKNOWN|PENDING)\b/i);
            if (changeMatch) {
                problemIdentifier = changeMatch[1].trim();
                // In a change email, both states are relevant for grouping logic
                states.push(changeMatch[2].toUpperCase(), changeMatch[3].toUpperCase());
            } else {
                // Regex for single state, e.g., "host/service is CRIT" or "IPsec tunnel is down"
                const singleStateMatch = subject.match(/^(.*?)(?:\s+is)?\s+(UP|DOWN|OK|WARN|CRIT|UNKNOWN|PENDING)\b/i);
                if (singleStateMatch) {
                    problemIdentifier = singleStateMatch[1].trim();
                    states.push(singleStateMatch[2].toUpperCase());
                }
            }

            if (problemIdentifier) {
                // Clean up identifier to make it more consistent
                problemIdentifier = problemIdentifier.replace(/^(check_mk:|\s*)/i, '').replace(/[\s\-\/]+$/, '').trim();

                if (!problemMap[problemIdentifier]) {
                    problemMap[problemIdentifier] = [];
                }
                // Pass the whole email and its detected states to the map
                problemMap[problemIdentifier].push({ email, states });
            }
        });

        // 2. Create groups for problems that show recovery (e.g., go from CRIT to OK)
        Object.entries(problemMap).forEach(([problemId, emailArr]) => {
            // A group needs at least two emails to show a change/recovery.
            if (emailArr.length < 2) return;

            const allStates = emailArr.flatMap(e => e.states);
            const hasProblemState = allStates.some(s => ['WARN', 'CRIT', 'UNKNOWN', 'DOWN'].includes(s));
            const hasOkState = allStates.some(s => ['OK', 'UP'].includes(s));

            // Group if there's evidence of a problem AND a recovery.
            if (hasProblemState && hasOkState) {
                const groupKey = problemId;
                if (!groups[groupKey]) {
                    groups[groupKey] = [];
                }
                emailArr.forEach(e => {
                    // Add email to the group if it hasn't been processed yet.
                    if (!processedIds.has(e.email.id)) {
                        groups[groupKey].push(e.email);
                        processedIds.add(e.email.id);
                    }
                });
            }
        });

        return { groups, processedIds };
    }

    function createEmailElement(email) {
        const listItem = document.createElement('li');
        listItem.dataset.id = email.id;
        listItem.classList.add('email-item');

        if (email.score * 100 > 70) {
            listItem.classList.add('highlight-red');
        }

        if (email.category === 'Bot') {
            listItem.classList.add('useless-email');
        }

        const mainContent = document.createElement('div');
        mainContent.className = 'email-main-content';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.addEventListener('click', e => e.stopPropagation());
        mainContent.appendChild(checkbox);

        const emailDetails = document.createElement('div');
        emailDetails.className = 'email-details';

        const from = document.createElement('span');
        from.className = 'from';
        from.textContent = email.from;
        emailDetails.appendChild(from);

        const subject = document.createElement('span');
        subject.className = 'subject';
        subject.textContent = email.subject;
        emailDetails.appendChild(subject);

        mainContent.appendChild(emailDetails);

        const emailMeta = document.createElement('div');
        emailMeta.className = 'email-meta';

        const scoreDiv = document.createElement('div');
        scoreDiv.className = 'score';
        scoreDiv.textContent = typeof email.score === 'number' ? `${Math.round(email.score * 100)}%` : 'N/A';
        emailMeta.appendChild(scoreDiv);

        const dateSpan = document.createElement('span');
        dateSpan.className = 'date';
        const dateValue = email.internalDate ? parseInt(email.internalDate, 10) : 0;
        if (dateValue > 0) {
            const date = new Date(dateValue);
            dateSpan.textContent = date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        } else {
            dateSpan.textContent = '';
        }
        emailMeta.appendChild(dateSpan);


        const reclassifyButtons = document.createElement('div');
        reclassifyButtons.className = 'reclassify-buttons';

        if (email.category === 'Human') {
            const moveToBotButton = document.createElement('button');
            moveToBotButton.innerHTML = '&#129302;'; // 🤖
            moveToBotButton.title = 'Move to Bot';
            moveToBotButton.className = 'btn btn-secondary';
            moveToBotButton.addEventListener('click', (e) => {
                e.stopPropagation();
                reclassifyEmail(email.id, 'Bot');
            });
            reclassifyButtons.appendChild(moveToBotButton);
        } else {
            const moveToHumanButton = document.createElement('button');
            moveToHumanButton.innerHTML = '&#128100;'; // 👤
            moveToHumanButton.title = 'Move to Human';
            moveToHumanButton.className = 'btn btn-secondary';
            moveToHumanButton.addEventListener('click', (e) => {
                e.stopPropagation();
                reclassifyEmail(email.id, 'Human');
            });
            reclassifyButtons.appendChild(moveToHumanButton);
        }

        const isPinned = pinnedEmails.some(pinnedEmail => pinnedEmail.id === email.id);

        if (isPinned) {
            const unpinButton = document.createElement('button');
            unpinButton.innerHTML = '&#128205;'; // 📍
            unpinButton.title = 'Unpin';
            unpinButton.className = 'btn btn-secondary';
            unpinButton.addEventListener('click', (e) => {
                e.stopPropagation();
                unpinEmail(email.id);
            });
            reclassifyButtons.appendChild(unpinButton);
        } else {
            const pinButton = document.createElement('button');
            pinButton.innerHTML = '&#128204;'; // 📌
            pinButton.title = 'Pin';
            pinButton.className = 'btn btn-secondary';
            pinButton.addEventListener('click', (e) => {
                e.stopPropagation();
                pinEmail(email.id);
            });
            reclassifyButtons.appendChild(pinButton);
        }

        emailMeta.appendChild(reclassifyButtons);

        const cardActions = document.createElement('div');
        cardActions.className = 'card-actions';

        const replyButton = document.createElement('button');
        replyButton.className = 'btn btn-sm btn-outline-secondary reply-button';
        replyButton.innerHTML = '<i class="fas fa-reply"></i>';
        replyButton.title = 'Reply to this email';

        replyButton.addEventListener('click', (e) => {
            e.stopPropagation(); // ESSENTIAL: Stop the click from opening the email body
            openReplyModal(email); // Manually open our custom modal
        });

        cardActions.appendChild(replyButton);

        const showButton = document.createElement('button');
        showButton.className = 'btn btn-sm btn-outline-secondary show-button';
        showButton.innerHTML = '&#128214;'; // Book emoji
        showButton.title = 'Show full email';

        showButton.addEventListener('click', (e) => {
            e.stopPropagation();
            openFullScreenEmail(email);
        });

        cardActions.appendChild(showButton);

        emailMeta.appendChild(cardActions);

        mainContent.appendChild(emailMeta);

        listItem.appendChild(mainContent);

        const snippet = document.createElement('p');
        snippet.className = 'snippet';
        snippet.textContent = email.snippet;
        listItem.appendChild(snippet);

        const body = document.createElement('div');
        body.className = 'body';
        if (email.bodyHtml) {
            body.innerHTML = DOMPurify.sanitize(email.bodyHtml);
        } else {
            body.textContent = email.body;
        }
        body.style.display = 'none';
        listItem.appendChild(body);

        listItem.addEventListener('click', () => {
            const isBodyVisible = body.style.display === 'block';
            body.style.display = isBodyVisible ? 'none' : 'block';
        });

        return listItem;
    }

    function pinEmail(emailId) {
        const emailIndex = emails.findIndex(e => e.id === emailId);
        if (emailIndex > -1) {
            const [pinnedEmail] = emails.splice(emailIndex, 1);
            pinnedEmails.push(pinnedEmail);
            rerenderEmails();
        }
    }

    function unpinEmail(emailId) {
        const emailIndex = pinnedEmails.findIndex(e => e.id === emailId);
        if (emailIndex > -1) {
            const [unpinnedEmail] = pinnedEmails.splice(emailIndex, 1);
            emails.push(unpinnedEmail);
            rerenderEmails();
        }
    }

    function createPairBoxElement(group, groupKey, emoji) {
        const box = document.createElement('div');
        box.className = 'pair-box';
        box.dataset.emailIds = group.map(email => email.id).join(',');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'pair-checkbox';
        checkbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            group.forEach(email => {
                const emailListItem = document.querySelector(`.email-item[data-id="${email.id}"]`);
                if (emailListItem) {
                    const innerCheckbox = emailListItem.querySelector('input[type="checkbox"]');
                    if (innerCheckbox) {
                        innerCheckbox.checked = isChecked;
                    }
                }
            });
        });
        box.appendChild(checkbox);

        const emojiSpan = document.createElement('span');
        emojiSpan.className = 'pair-emoji';
        emojiSpan.textContent = emoji;
        box.appendChild(emojiSpan);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'pair-content';

        const title = document.createElement('h3');
        title.textContent = groupKey;
        contentDiv.appendChild(title);

        group.sort((a, b) => a.internalDate - b.internalDate).forEach(email => {
            const emailLine = document.createElement('p');
            const date = new Date(parseInt(email.internalDate, 10));
            const dateString = date.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
            const timeString = date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            emailLine.textContent = `(${dateString} ${timeString}) - ${email.subject}`;
            contentDiv.appendChild(emailLine);
        });
        box.appendChild(contentDiv);
        return box;
    }

    function displayEmails(emailsToDisplay, listContainer, highlightedContainer, showGroups) {
        if (!listContainer) return;
        listContainer.innerHTML = '';
        if (highlightedContainer) {
            highlightedContainer.innerHTML = '';
        }

        if (!emailsToDisplay || emailsToDisplay.length === 0) {
            listContainer.innerHTML = '<p>No unread emails found in this category.</p>';
            return;
        }

        let processedIds = new Set();
        if (showGroups && highlightedContainer) {
            const { groups, processedIds: pIds } = findEmailGroups(emailsToDisplay);
            processedIds = pIds;
            const emojis = ['♣️', '♠️', '♥️', '♦️'];

            for (let i = emojis.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [emojis[i], emojis[j]] = [emojis[j], emojis[i]];
            }

            Object.entries(groups).forEach(([groupKey, group], index) => {
                if (group.length > 0) {
                    const emoji = emojis[index % emojis.length];
                    const pairBox = createPairBoxElement(group, groupKey, emoji);
                    highlightedContainer.appendChild(pairBox);
                }
            });
        }

        const regularEmailList = document.createElement('ul');
        emailsToDisplay.forEach(email => {
            const emailElement = createEmailElement(email);
            if (processedIds.has(email.id)) {
                emailElement.classList.add('is-grouped');
            }
            regularEmailList.appendChild(emailElement);
        });

        listContainer.appendChild(regularEmailList);
    }

    function setupAutoRefresh() {
        const interval = parseInt(autoRefreshSelect.value, 10);

        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }

        if (interval > 0) {
            refreshTimer = setInterval(fetchAndDisplayEmails, interval * 1000);
        }
    }

    autoRefreshSelect.addEventListener('change', setupAutoRefresh);
    emailLimitSelect.addEventListener('change', fetchAndDisplayEmails);

    fetchAndDisplayEmails();

    // --- Log Panel ---
    const logPanel = document.getElementById('log-panel');
    const openLogPanelButton = document.getElementById('open-log-panel');
    const closeLogPanelButton = document.getElementById('close-log-panel');
    const logFileSelector = document.getElementById('log-file-selector');
    const refreshLogButton = document.getElementById('refresh-log-button');
    const logContent = document.getElementById('log-content');
    const logPrevPageButton = document.getElementById('log-prev-page');
    const logNextPageButton = document.getElementById('log-next-page');
    const logPageInfo = document.getElementById('log-page-info');

    let logsLoaded = false;
    let currentPage = 0;
    let totalLines = 0;
    const linesPerPage = 100;

    openLogPanelButton.addEventListener('click', () => {
        logPanel.classList.add('open');
        if (!logsLoaded) {
            fetchLogFiles();
            logsLoaded = true;
        }
    });

    closeLogPanelButton.addEventListener('click', () => {
        logPanel.classList.remove('open');
    });

    async function fetchLogFiles() {
        try {
            const response = await fetch('/api/logs');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const logFiles = await response.json();
            logFileSelector.innerHTML = '';
            logFiles.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                logFileSelector.appendChild(option);
            });
            if (logFiles.length > 0) {
                selectLogFile(logFiles[0]);
            }
        } catch (error) {
            console.error('Error fetching log files:', error);
            logContent.textContent = 'Error fetching log files.';
        }
    }

    async function selectLogFile(logFile) {
        if (!logFile) return;
        try {
            const response = await fetch(`/api/logs/${logFile}?meta=true`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const meta = await response.json();
            totalLines = meta.totalLines;
            currentPage = 0;
            fetchLogContent(logFile, currentPage);
        } catch (error) {
            console.error(`Error fetching log meta for ${logFile}:`, error);
            logContent.textContent = `Error fetching log meta for ${logFile}.`;
        }
    }

    async function fetchLogContent(logFile, page) {
        if (!logFile) return;
        const offset = page * linesPerPage;
        try {
            const response = await fetch(`/api/logs/${logFile}?offset=${offset}&limit=${linesPerPage}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const text = await response.text();
            logContent.textContent = text;
            updatePaginationControls();
        } catch (error) {
            console.error(`Error fetching log content for ${logFile}:`, error);
            logContent.textContent = `Error fetching log content for ${logFile}.`;
        }
    }

    function updatePaginationControls() {
        const totalPages = Math.ceil(totalLines / linesPerPage);
        logPageInfo.textContent = `Page ${currentPage + 1} of ${totalPages}`;
        logPrevPageButton.disabled = currentPage === 0;
        logNextPageButton.disabled = currentPage >= totalPages - 1;
    }

    logFileSelector.addEventListener('change', () => {
        selectLogFile(logFileSelector.value);
    });

    refreshLogButton.addEventListener('click', () => {
        fetchLogContent(logFileSelector.value, currentPage);
    });

    logPrevPageButton.addEventListener('click', () => {
        if (currentPage > 0) {
            currentPage--;
            fetchLogContent(logFileSelector.value, currentPage);
        }
    });

    logNextPageButton.addEventListener('click', () => {
        const totalPages = Math.ceil(totalLines / linesPerPage);
        if (currentPage < totalPages - 1) {
            currentPage++;
            fetchLogContent(logFileSelector.value, currentPage);
        }
    });
    // --- End Log Panel ---

    // --- LLM Status Check ---
    const llmStatusIndicator = document.getElementById('llm-status');

    async function checkLlmStatus() {
        try {
            const response = await fetch(`https://${window.location.hostname}:5001/api/health`);
            if (response.ok) {
                const data = await response.json();
                if (data.status === 'ok') {
                    llmStatusIndicator.classList.remove('llm-status-down');
                    llmStatusIndicator.classList.add('llm-status-up');
                    llmStatusIndicator.title = 'LLM is operational';
                } else {
                    llmStatusIndicator.classList.remove('llm-status-up');
                    llmStatusIndicator.classList.add('llm-status-down');
                    llmStatusIndicator.title = 'LLM is not responding';
                }
            } else {
                llmStatusIndicator.classList.remove('llm-status-up');
                llmStatusIndicator.classList.add('llm-status-down');
                llmStatusIndicator.title = 'LLM is not responding';
            }
        } catch (error) {
            console.error('Error checking LLM status:', error);
            llmStatusIndicator.classList.remove('llm-status-up');
            llmStatusIndicator.classList.add('llm-status-down');
            llmStatusIndicator.title = 'LLM is not responding';
        }
    }

    // Check status immediately and then every 10 seconds
    checkLlmStatus();
    setInterval(checkLlmStatus, 10000);

    // --- Notes Panel Logic ---
    const notesPanel = document.getElementById('notes-panel');
    const toggleNotesPanelButton = document.getElementById('toggle-notes-panel');
    const closeNotesPanelButton = document.getElementById('close-notes-panel');
    const noteSelector = document.getElementById('note-selector');
    const newNoteButton = document.getElementById('new-note-button');
    const deleteNoteButton = document.getElementById('delete-note-button');
    const saveNoteButton = document.getElementById('save-note-button');
    const noteContent = document.getElementById('note-content');

    const easyMDE = new EasyMDE({ element: noteContent });

    let notes = [];
    let currentNoteId = null;

    async function fetchNotes() {
        try {
            const response = await fetch('/api/notes');
            if (!response.ok) throw new Error('Failed to fetch notes');
            notes = await response.json();
            renderNoteSelector();
            displaySelectedNote();
        } catch (error) {
            console.error('Error fetching notes:', error);
            alert('Could not fetch notes.');
        }
    }

    function renderNoteSelector() {
        const selectedValue = noteSelector.value;
        noteSelector.innerHTML = '';
        notes.forEach(note => {
            const option = document.createElement('option');
            option.value = note.id;
            option.textContent = note.title;
            noteSelector.appendChild(option);
        });
        noteSelector.value = selectedValue;
    }

    function displaySelectedNote() {
        currentNoteId = noteSelector.value;
        const selectedNote = notes.find(note => note.id === currentNoteId);
        if (selectedNote) {
            easyMDE.value(selectedNote.content);
        } else {
            easyMDE.value('');
        }
    }

    toggleNotesPanelButton.addEventListener('click', () => {
        notesPanel.classList.toggle('open');
        if (notesPanel.classList.contains('open') && notes.length === 0) {
            fetchNotes();
        }
    });

    closeNotesPanelButton.addEventListener('click', () => {
        notesPanel.classList.remove('open');
    });

    noteSelector.addEventListener('change', displaySelectedNote);

    newNoteButton.addEventListener('click', async () => {
        const title = prompt('Enter a title for the new note:');
        if (!title) return;

        try {
            const response = await fetch('/api/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, content: '' }),
            });
            if (!response.ok) throw new Error('Failed to create note');
            const newNote = await response.json();
            notes.push(newNote);
            renderNoteSelector();
            noteSelector.value = newNote.id;
            displaySelectedNote();
        } catch (error) {
            console.error('Error creating note:', error);
            alert('Could not create note.');
        }
    });

    deleteNoteButton.addEventListener('click', async () => {
        if (!currentNoteId) {
            alert('Please select a note to delete.');
            return;
        }

        if (!confirm('Are you sure you want to delete this note?')) return;

        try {
            const response = await fetch(`/api/notes/${currentNoteId}`, {
                method: 'DELETE',
            });
            if (!response.ok) throw new Error('Failed to delete note');
            notes = notes.filter(note => note.id !== currentNoteId);
            renderNoteSelector();
            displaySelectedNote();
        } catch (error) {
            console.error('Error deleting note:', error);
            alert('Could not delete note.');
        }
    });

    saveNoteButton.addEventListener('click', async () => {
        if (!currentNoteId) {
            alert('Please select a note to save.');
            return;
        }

        const content = easyMDE.value();
        const note = notes.find(note => note.id === currentNoteId);

        try {
            const response = await fetch(`/api/notes/${currentNoteId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: note.title, content }),
            });
            if (!response.ok) throw new Error('Failed to save note');
            const updatedNote = await response.json();
            const noteIndex = notes.findIndex(n => n.id === currentNoteId);
            notes[noteIndex] = updatedNote;
            alert('Note saved successfully.');
        } catch (error) {
            console.error('Error saving note:', error);
            alert('Could not save note.');
        }
    });

    // --- End Notes Panel Logic ---

    // Walkthrough code starts here

    // Walkthrough code starts here

    // --- Manual Reply Modal Logic (Bypassing Bootstrap JS) ---
    const replyModalEl = document.getElementById('replyModal');
    const sendReplyBtn = document.getElementById('send-reply-btn');
    const cancelReplyButtons = replyModalEl.querySelectorAll('[data-bs-dismiss="modal"]');

    function openReplyModal(email) {
        if (!email || !replyModalEl) return;

        // Populate the modal fields
        replyModalEl.querySelector('#reply-to').value = email.from;
        const subjectField = replyModalEl.querySelector('#reply-subject');
        subjectField.value = email.subject.startsWith('Re: ') ? email.subject : `Re: ${email.subject}`;

        const originalBody = email.body.split('\n').map(line => `> ${line}`).join('\n');
        replyModalEl.querySelector('#reply-body').value = `

---
${originalBody}`;

        // Pass the email ID to the send button
        sendReplyBtn.dataset.originalMessageId = email.id;

        // Manually show the modal
        document.body.classList.add('modal-open');
        replyModalEl.style.display = 'block';
        replyModalEl.classList.add('show');
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop fade show';
        document.body.appendChild(backdrop);
    }

    function closeReplyModal() {
        if (!replyModalEl) return;

        // Manually hide the modal
        document.body.classList.remove('modal-open');
        replyModalEl.style.display = 'none';
        replyModalEl.classList.remove('show');
        const backdrop = document.querySelector('.modal-backdrop');
        if (backdrop) {
            backdrop.remove();
        }
    }

    // Listener for the send button
    sendReplyBtn.addEventListener('click', async () => {
        const originalMessageId = sendReplyBtn.dataset.originalMessageId;
        const replyText = document.getElementById('reply-body').value;
        const to = document.getElementById('reply-to').value;
        const subject = document.getElementById('reply-subject').value;

        if (!replyText.trim()) {
            alert('Message cannot be empty.');
            return;
        }

        try {
            const response = await fetch('/api/send-reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ originalMessageId, replyText, to, subject })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Failed to send reply.');
            }

            const result = await response.json();
            alert(result.message);
            closeReplyModal();

        } catch (error) {
            console.error('Error sending reply:', error);
            alert(`Error: ${error.message}`);
        }
    });

    // Listeners for cancel/close buttons
    cancelReplyButtons.forEach(button => {
        button.addEventListener('click', () => {
            closeReplyModal();
        });
    });

    const aiutoButton = document.getElementById('aiuto-button');
    const walkthroughOverlay = document.getElementById('walkthrough-overlay');
    const walkthroughBox = document.getElementById('walkthrough-box');
    const walkthroughText = document.getElementById('walkthrough-text');
    const walkthroughNext = document.getElementById('walkthrough-next');
    const walkthroughEnd = document.getElementById('walkthrough-end');

    let currentWalkthroughStep = 0;
    const walkthroughSteps = [
        {
            selector: '#aiuto-button',
            text: 'Benvenuto! Questo è il pulsante di aiuto. Cliccalo in qualsiasi momento per iniziare questo tour guidato e scoprire le funzionalità dell\'applicazione.',
            position: 'bottom'
        },
        {
            selector: '.theme-switch-wrapper',
            text: 'Clicca su questa icona per passare dalla modalità chiara a quella scura, per un comfort visivo ottimale.',
            position: 'left'
        },
        {
            selector: '#llm-status',
            text: 'Questo indicatore mostra lo stato del modello di linguaggio (LLM). Verde significa operativo, rosso indica un problema.',
            position: 'bottom'
        },
        {
            selector: '#toggle-calendar-panel',
            text: 'Apri o chiudi il pannello del calendario di Google per gestire i tuoi eventi senza lasciare l\'applicazione.',
            position: 'bottom'
        },
        {
            selector: '#toggle-notes-panel',
            text: 'Accedi al pannello delle note per creare, modificare o eliminare appunti personali in formato Markdown.',
            position: 'bottom'
        },
        {
            selector: '#email-stats',
            text: 'Qui trovi un riepilogo delle email non lette, con il totale e la suddivisione tra le categorie "Human" e "Bot".',
            position: 'bottom'
        },
        {
            selector: '#email-limit',
            text: 'Scegli quante email visualizzare contemporaneamente. Utile per gestire grandi volumi di messaggi.',
            position: 'bottom'
        },
        {
            selector: '#auto-refresh',
            text: 'Imposta un intervallo per l\'aggiornamento automatico della lista di email, per avere sempre la situazione sotto controllo.',
            position: 'bottom'
        },
        {
            selector: '#select-all-checkbox',
            text: 'Usa questa casella per selezionare o deselezionare rapidamente tutte le email attualmente visibili.',
            position: 'bottom'
        },
        {
            selector: '#select-current-tab-checkbox',
            text: 'Seleziona tutte le email presenti solo nella scheda (Tab) attualmente attiva.',
            position: 'bottom'
        },
        {
            selector: '#select-useless-checkbox',
            text: 'Questo strumento seleziona in automatico le email che il modello ha identificato come probabilmente irrilevanti (con uno score basso).',
            position: 'bottom'
        },
        {
            selector: '#sort-score-button',
            text: 'Ordina le email per punteggio di importanza, dalla più rilevante alla meno rilevante, secondo il modello AI.',
            position: 'bottom'
        },
        {
            selector: '#sort-date-button',
            text: 'Ordina le email cronologicamente, mostrando per prime le più recenti.',
            position: 'bottom'
        },
        {
            selector: '#mark-read-button',
            text: 'Dopo averle selezionate, usa questo pulsante per segnare più email come lette.',
            position: 'bottom'
        },
        {
            selector: '#fine-tune-llm-button',
            text: 'Avvia il processo di "fine-tuning" per addestrare il modello LLM con le nuove valutazioni e riclassificazioni che hai fornito, migliorandone l\'accuratezza futura.',
            position: 'bottom'
        },
        {
            selector: '.tab-container',
            text: 'Usa queste schede per navigare tra le email classificate come "Human" (importanti), "Bot" (automatiche) e "Pinned" (salvate).',
            position: 'bottom'
        },
        {
            selector: '.pair-box',
            text: 'Questi riquadri raggruppano email correlate (es. alert di sistema e la loro risoluzione) per una gestione più semplice e veloce.',
            position: 'top'
        },
        {
            selector: '.email-item',
            text: 'Questa è un\'email. Clicca per leggerne il contenuto. A destra trovi lo score di importanza, la data e i pulsanti di azione.',
            position: 'top'
        },
        {
            selector: '.rating-widget',
            text: 'Valuta l\'importanza di un\'email usando le stelle. Il tuo feedback è fondamentale per addestrare il modello a classificare meglio i futuri messaggi.',
            position: 'left'
        },
        {
            selector: '.reclassify-buttons',
            text: 'Con questi pulsanti puoi spostare un\'email da "Human" a "Bot" (e viceversa) o "pinnarla" per ritrovarla facilmente nella scheda "Pinned".',
            position: 'left'
        },
        {
            selector: '.card-actions',
            text: 'Da qui puoi rispondere direttamente a un\'email o aprirla a schermo intero per una lettura più comoda.',
            position: 'left'
        },
        {
            selector: '#open-log-panel',
            text: 'Apri il pannello dei log per visualizzare i registri delle attività del server e del backend, utile per il debug.',
            position: 'top'
        }
    ];

    function showWalkthroughStep(stepIndex) {
        if (stepIndex < 0 || stepIndex >= walkthroughSteps.length) {
            endWalkthrough();
            return;
        }

        currentWalkthroughStep = stepIndex;
        const step = walkthroughSteps[currentWalkthroughStep];
        const targetElement = document.querySelector(step.selector);

        if (!targetElement) {
            console.warn(`Walkthrough target element not found: ${step.selector}`);
            // Attempt to find a fallback element or skip this step
            if (stepIndex + 1 < walkthroughSteps.length) {
                showWalkthroughStep(stepIndex + 1); // Skip to next step
            } else {
                endWalkthrough();
            }
            return;
        }

        walkthroughText.textContent = step.text;

        // Position the walkthrough box
        const targetRect = targetElement.getBoundingClientRect();
        const boxRect = walkthroughBox.getBoundingClientRect();

        walkthroughBox.style.display = 'block';
        walkthroughOverlay.style.display = 'block';

        walkthroughBox.setAttribute("data-position", step.position);

        // Reset positioning
        walkthroughBox.style.top = '';
        walkthroughBox.style.bottom = '';
        walkthroughBox.style.left = '';
        walkthroughBox.style.right = '';
        walkthroughBox.style.transform = '';

        // Calculate position based on step.position
        let top, left;
        const margin = 10; // Small margin from the target element

        switch (step.position) {
            case 'top':
                top = targetRect.top - boxRect.height - margin;
                left = targetRect.left + (targetRect.width / 2) - (boxRect.width / 2);
                break;
            case 'bottom':
                top = targetRect.bottom + margin;
                left = targetRect.left + (targetRect.width / 2) - (boxRect.width / 2);
                break;
            case 'left':
                top = targetRect.top + (targetRect.height / 2) - (boxRect.height / 2);
                left = targetRect.left - boxRect.width - margin;
                break;
            case 'right':
                top = targetRect.top + (targetRect.height / 2) - (boxRect.height / 2);
                left = targetRect.right + margin;
                break;
            default: // center or fallback
                top = targetRect.top + (targetRect.height / 2) - (boxRect.height / 2);
                left = targetRect.left + (targetRect.width / 2) - (boxRect.width / 2);
                break;
        }

        // Adjust if out of viewport
        if (top < 0) top = margin;
        if (left < 0) left = margin;
        if (top + boxRect.height > window.innerHeight) top = window.innerHeight - boxRect.height - margin;
        if (left + boxRect.width > window.innerWidth) left = window.innerWidth - boxRect.width - margin;

        walkthroughBox.style.top = `${top}px`;
        walkthroughBox.style.left = `${left}px`;

        // Update button text
        if (currentWalkthroughStep === walkthroughSteps.length - 1) {
            walkthroughNext.textContent = 'Fine';
        } else {
            walkthroughNext.textContent = 'Avanti';
        }
    }

    function startWalkthrough() {
        showWalkthroughStep(0);
    }

    function endWalkthrough() {
        walkthroughBox.style.display = 'none';
        walkthroughOverlay.style.display = 'none';
        currentWalkthroughStep = 0;
        walkthroughNext.textContent = 'Avanti'; // Reset button text
    }

    aiutoButton.addEventListener('click', startWalkthrough);
    walkthroughNext.addEventListener('click', () => {
        if (currentWalkthroughStep === walkthroughSteps.length - 1) {
            endWalkthrough();
        } else {
            showWalkthroughStep(currentWalkthroughStep + 1);
        }
    });
    walkthroughEnd.addEventListener('click', endWalkthrough);

    // Close walkthrough if overlay is clicked
    walkthroughOverlay.addEventListener('click', endWalkthrough);

    const fullEmailModal = document.getElementById('full-email-modal');
    const fullEmailBody = document.getElementById('full-email-body');
    const closeFullEmailButton = document.getElementById('close-full-email');

    function openFullScreenEmail(email) {
        if (email.bodyHtml) {
            fullEmailBody.innerHTML = DOMPurify.sanitize(email.bodyHtml);
        } else {
            fullEmailBody.textContent = email.body;
        }
        fullEmailModal.style.display = 'flex';
    }

    function closeFullScreenEmail() {
        fullEmailModal.style.display = 'none';
        fullEmailBody.innerHTML = '';
    }

    closeFullEmailButton.addEventListener('click', closeFullScreenEmail);

    // Close modal on escape key press
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && fullEmailModal.style.display === 'flex') {
            closeFullScreenEmail();
        }
    });

    const toggleCalendarPanelButton = document.getElementById('toggle-calendar-panel');
    const calendarPanel = document.getElementById('calendar-panel');

    toggleCalendarPanelButton.addEventListener('click', () => {
        calendarPanel.classList.toggle('open');
    });
});