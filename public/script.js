document.addEventListener('DOMContentLoaded', () => {
    console.log('--- DOMContentLoaded START ---');

    const select = document.getElementById('gmail-category-select');
    const customInput = document.getElementById('custom-label-input');

    if (select && customInput) {
        select.addEventListener('change', () => {
            if (select.value === 'CUSTOM_LABEL') {
                customInput.style.display = 'block';
                customInput.focus();
            } else {
                customInput.style.display = 'none';
                customInput.value = '';
            }
        });
    }

    function showTab(tabName) {
        const humanView = document.getElementById('human-view');
        const botView = document.getElementById('bot-view');
        const cloudMonitorView = document.getElementById('cloud-monitor-view');
        const pinnedView = document.getElementById('pinned-view');
        const chatView = document.getElementById('chat-view');
        const humanTab = document.getElementById('human-tab');
        const botTab = document.getElementById('bot-tab');
        const cloudMonitorTab = document.getElementById('cloud-monitor-tab');
        const pinnedTab = document.getElementById('show-pinned-emails');
        const chatTab = document.getElementById('chat-tab');

        if (humanView) humanView.style.display = tabName === 'human' ? 'block' : 'none';
        if (botView) botView.style.display = tabName === 'bot' ? 'block' : 'none';
        if (cloudMonitorView) cloudMonitorView.style.display = tabName === 'cloud-monitor' ? 'block' : 'none';
        if (pinnedView) pinnedView.style.display = tabName === 'pinned' ? 'block' : 'none';

        if (humanTab) humanTab.classList.toggle('active', tabName === 'human');
        if (botTab) botTab.classList.toggle('active', tabName === 'bot');
        if (cloudMonitorTab) cloudMonitorTab.classList.toggle('active', tabName === 'cloud-monitor');
        if (pinnedTab) pinnedTab.classList.toggle('active', tabName === 'pinned');

        const categoryFilterWrapper = document.getElementById('category-filter-wrapper');
        const cloudHoursFilterWrapper = document.getElementById('cloud-hours-filter-wrapper');
        if (categoryFilterWrapper && cloudHoursFilterWrapper) {
            categoryFilterWrapper.style.display = (tabName === 'human' || tabName === 'bot') ? 'flex' : 'none';
            cloudHoursFilterWrapper.style.display = (tabName === 'cloud-monitor') ? 'flex' : 'none';
        }
    }

    // quando ti serve il valore “categoria”:
    function getSelectedCategory() {
        if (select.value === 'CUSTOM_LABEL') {
            return customInput.value.trim(); // qui hai il nome etichetta scritto da te
        }
        return select.value;
    }

    function updateCategorySelect(labelMap) {
        if (!labelMap || Object.keys(labelMap).length === 0) return;

        const select = document.getElementById('gmail-category-select');
        const currentValue = select.value;

        // Svuota le opzioni mantenendo quelle base se necessario (o ricreandole)
        select.innerHTML = '';

        // Opzione "Tutte"
        const allOpt = document.createElement('option');
        allOpt.value = 'ALL';
        allOpt.textContent = 'Tutte';
        select.appendChild(allOpt);

        // Opzioni Gmail dalla labelMap
        // Ordiniamo le etichette per nome
        const sortedLabels = Object.entries(labelMap).sort((a, b) => a[1].localeCompare(b[1]));

        sortedLabels.forEach(([id, name]) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = name;
            select.appendChild(opt);
        });

        // Opzione "Scrivi..."
        const customOpt = document.createElement('option');
        customOpt.value = 'CUSTOM_LABEL';
        customOpt.textContent = 'Scrivi...';
        select.appendChild(customOpt);

        // Ripristina la selezione precedente se esiste ancora
        if (Array.from(select.options).some(opt => opt.value === currentValue)) {
            select.value = currentValue;
        } else {
            select.value = 'ALL';
        }
    }
    const body = document.body;

    // Theme Switch in Account Menu
    const themeSwitch = document.getElementById('theme-switch');
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        body.classList.add('dark-mode');
        if (themeSwitch) themeSwitch.checked = true;
    }

    if (themeSwitch) {
        themeSwitch.addEventListener('change', () => {
            body.classList.toggle('dark-mode', themeSwitch.checked);
            localStorage.setItem('theme', themeSwitch.checked ? 'dark' : 'light');
        });
    }


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
    // const autoRefreshSelect = document.getElementById('auto-refresh'); // REMOVED
    const loadingMessage = document.getElementById('loading-message');
    const pinnedEmailsContainer = document.getElementById('pinned-emails-container');
    const pinnedView = document.getElementById('pinned-view');
    const humanTab = document.getElementById('human-tab');
    const botTab = document.getElementById('bot-tab');
    const cloudMonitorTab = document.getElementById('cloud-monitor-tab');

    if (humanTab) humanTab.addEventListener('click', () => showTab('human'));
    if (botTab) botTab.addEventListener('click', () => showTab('bot'));
    if (cloudMonitorTab) cloudMonitorTab.addEventListener('click', () => showTab('cloud-monitor'));

    const sendChatBtn = document.getElementById('send-chat-btn');
    const chatMessageInput = document.getElementById('chat-message-input');

    if (sendChatBtn) {
        sendChatBtn.addEventListener('click', () => sendChatMessage());
    }

    if (chatMessageInput) {
        chatMessageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }

    // Chat Panel Toggle Logic
    const chatPanel = document.getElementById('chat-panel');
    const toggleChatBtn = document.getElementById('toggle-chat-panel');
    const closeChatBtn = document.getElementById('close-chat-panel');
    const chatBadge = document.getElementById('chat-badge');
    let hasFetchedChatSpaces = false;

    if (toggleChatBtn && chatPanel) {
        toggleChatBtn.addEventListener('click', () => {
            if (chatPanel.style.display === 'none' || chatPanel.style.display === '') {
                chatPanel.style.display = 'flex';
                if (chatBadge) chatBadge.style.display = 'none'; // hide badge when opened
                if (!hasFetchedChatSpaces) {
                    hasFetchedChatSpaces = true;
                    fetchChatSpaces();
                }
            } else {
                chatPanel.style.display = 'none';
            }
        });
    }

    // Check for preloaded chat data
    if (window.__PRELOADED_CHAT__) {
        console.log('Using preloaded chat data...');
        hasFetchedChatSpaces = true;

        const preloadData = window.__PRELOADED_CHAT__;
        if (preloadData.myId) myChatId = preloadData.myId;

        // Wait for DOM to be fully ready before rendering (should be fine as we are in DOMContentLoaded)
        renderChatSpaces(preloadData.spaces);

        // Populate local cache for preloaded messages
        if (preloadData.initialMessages) {
            window.__CHAT_CACHE__ = preloadData.initialMessages;
            window.__MEMBERS_MAP_CACHE__ = preloadData.membersMapMap || {};
        }
    }

    if (closeChatBtn && chatPanel) {
        closeChatBtn.addEventListener('click', () => {
            chatPanel.style.display = 'none';
        });
    }

    // Chat Panel Draggable Logic
    const chatPanelHeader = document.getElementById('chat-panel-header');
    let isDraggingChat = false;
    let chatDragOffsetX = 0;
    let chatDragOffsetY = 0;

    if (chatPanelHeader && chatPanel) {
        chatPanelHeader.addEventListener('mousedown', (e) => {
            isDraggingChat = true;
            const rect = chatPanel.getBoundingClientRect();
            chatDragOffsetX = e.clientX - rect.left;
            chatDragOffsetY = e.clientY - rect.top;
            document.body.style.userSelect = 'none'; // Prevent text selection
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDraggingChat) return;
            let newX = e.clientX - chatDragOffsetX;
            let newY = e.clientY - chatDragOffsetY;

            // Boundary checks
            const maxX = window.innerWidth - chatPanel.offsetWidth;
            const maxY = window.innerHeight - chatPanel.offsetHeight;
            newX = Math.max(0, Math.min(newX, maxX));
            newY = Math.max(0, Math.min(newY, maxY));

            chatPanel.style.left = `${newX}px`;
            chatPanel.style.top = `${newY}px`;
            chatPanel.style.right = 'auto'; // Disable right anchoring once dragged
        });

        document.addEventListener('mouseup', () => {
            if (isDraggingChat) {
                isDraggingChat = false;
                document.body.style.userSelect = '';
            }
        });
    }

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

    let allEmails = [];
    let pinnedEmails = [];
    let refreshTimer = null;
    let accountEmail = ''; // Global variable to store active Gmail account
    let labelMap = {};
    let currentSortMode = 'score'; // 'date' o 'score'
    let cloudMonitorIssues = [];
    let activeSpaceId = null;
    let chatRefreshTimer = null;
    let myChatId = null; // Store the user's Google Chat ID (e.g., users/123...)

    // Track previously seen chat message IDs for notifications
    const seenChatMessageIds = new Set();

    function showChatNotification(senderName, messageText) {
        const container = document.getElementById('chat-notifications-container');
        if (!container) return;

        const notif = document.createElement('div');
        notif.className = 'chat-notification';
        notif.innerHTML = `
            <div class="chat-notification-header"><i class="fa-solid fa-message"></i> ${DOMPurify.sanitize(senderName)}</div>
            <div class="chat-notification-body">${DOMPurify.sanitize(messageText)}</div>
        `;

        container.appendChild(notif);

        // Auto remove after 5 seconds
        setTimeout(() => {
            notif.classList.add('fade-out');
            setTimeout(() => {
                if (container.contains(notif)) {
                    container.removeChild(notif);
                }
            }, 500); // wait for fade out transition
        }, 5000);
    }

    // State for Cloud Monitor folders and files expansion
    const cloudMonitorState = {
        openFolders: new Set(),
        openFiles: new Set()
    };
    const selectedEmailIds = new Set();
    const expandedEmailIds = new Set();

    // View Mode Selection
    const viewModeSelect = document.getElementById('view-mode-select');
    let viewMode = localStorage.getItem('view_mode') || 'native';
    viewModeSelect.value = viewMode;

    viewModeSelect.addEventListener('change', (e) => {
        viewMode = e.target.value;
        localStorage.setItem('view_mode', viewMode);
    });

    // --- Email Notes Logic ---
    async function loadEmailNotes(emailId) {
        try {
            const response = await fetch(`/api/email-notes/${emailId}`);
            if (!response.ok) throw new Error('Failed to fetch email notes');
            const notes = await response.json();

            const bodyContainer = document.getElementById('full-email-body');
            let notesSection = bodyContainer.querySelector('.email-notes-section');

            if (!notesSection) {
                notesSection = document.createElement('div');
                notesSection.className = 'email-notes-section';
                notesSection.innerHTML = `
                    <h4><i class="fa-solid fa-comments"></i> Note ed Annotazioni</h4>
                    <div class="email-notes-container"></div>
                    <div class="email-note-form-container"></div>
                `;
                bodyContainer.appendChild(notesSection);
            }

            const notesContainer = notesSection.querySelector('.email-notes-container');
            renderEmailNotes(notes, notesContainer, emailId);

            const formContainer = notesSection.querySelector('.email-note-form-container');
            addEmailNoteUI(formContainer, emailId);

        } catch (error) {
            console.error('Error loading email notes:', error);
        }
    }

    function renderEmailNotes(notes, container, emailId) {
        container.innerHTML = '';
        if (notes.length === 0) {
            container.innerHTML = '<p class="text-muted small">Nessuna nota presente per questa email.</p>';
            return;
        }

        // Separate top-level notes and replies
        const topLevelNotes = notes.filter(n => !n.parentId);
        const replies = notes.filter(n => n.parentId);

        topLevelNotes.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).forEach(note => {
            const noteEl = createNoteElement(note, emailId);
            container.appendChild(noteEl);

            // Append replies for this note
            const noteReplies = replies
                .filter(r => r.parentId === note.id)
                .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

            noteReplies.forEach(reply => {
                const replyEl = createNoteElement(reply, emailId, true);
                container.appendChild(replyEl);
            });
        });
    }

    function createNoteElement(note, emailId, isReply = false) {
        const div = document.createElement('div');
        div.className = `email-note ${isReply ? 'is-reply' : ''}`;
        div.innerHTML = `
            <div class="email-note-meta">
                <span class="email-note-user"><i class="fa-solid fa-user"></i> ${DOMPurify.sanitize(note.userId)}</span>
                <span class="email-note-date">${new Date(note.createdAt).toLocaleString()}</span>
            </div>
            <div class="email-note-content">${DOMPurify.sanitize(note.content)}</div>
            ${!isReply ? `
                <div class="email-note-actions">
                    <button class="email-note-reply-btn" data-parent-id="${note.id}">
                        <i class="fa-solid fa-reply"></i> Rispondi
                    </button>
                </div>
                <div class="reply-form-container" id="reply-form-${note.id}"></div>
            ` : ''}
        `;

        if (!isReply) {
            const replyBtn = div.querySelector('.email-note-reply-btn');
            replyBtn.addEventListener('click', () => {
                const replyFormContainer = div.querySelector('.reply-form-container');
                if (replyFormContainer.innerHTML === '') {
                    addEmailNoteUI(replyFormContainer, emailId, note.id);
                    replyBtn.innerHTML = '<i class="fa-solid fa-times"></i> Annulla';
                } else {
                    replyFormContainer.innerHTML = '';
                    replyBtn.innerHTML = '<i class="fa-solid fa-reply"></i> Rispondi';
                }
            });
        }

        return div;
    }

    function addEmailNoteUI(container, emailId, parentId = null) {
        container.innerHTML = `
            <div class="email-note-form">
                <textarea placeholder="${parentId ? 'Scrivi una risposta...' : 'Aggiungi una nota per gli altri utenti...'}" class="form-control"></textarea>
                <div class="email-note-form-actions">
                    <button class="btn btn-sm btn-primary save-note-btn">
                        <i class="fa-solid fa-paper-plane"></i> ${parentId ? 'Invia Risposta' : 'Salva Nota'}
                    </button>
                </div>
            </div>
        `;

        const textarea = container.querySelector('textarea');
        container.querySelector('.save-note-btn').addEventListener('click', async () => {
            const content = textarea.value.trim();
            if (!content) return;
            await saveEmailNote(emailId, content, parentId);
        });
    }

    async function saveEmailNote(emailId, content, parentId) {
        try {
            const response = await fetch('/api/email-notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emailId, content, parentId })
            });

            if (!response.ok) throw new Error('Failed to save email note');

            // Refresh notes
            loadEmailNotes(emailId);
        } catch (error) {
            console.error('Error saving email note:', error);
            alert('Errore durante il salvataggio della nota.');
        }
    }

    // --- Logout
    // The previous implementation used axios which was not defined.
    // We already have a correct logout listener at the end of DOMContentLoaded.

    // Hide AIUTO button if not needed (optional based on user request to "clean up")
    // Account Modal Logic
    const accountModal = document.getElementById('account-modal');
    const accountBtn = document.getElementById('account-window-btn');
    const closeAccountBtn = document.getElementById('close-account-modal');

    if (accountBtn && accountModal) {
        accountBtn.addEventListener('click', () => {
            accountModal.style.display = 'flex';
        });
    }

    if (closeAccountBtn && accountModal) {
        closeAccountBtn.addEventListener('click', () => {
            accountModal.style.display = 'none';
        });
    }

    // Close modal on click outside
    window.addEventListener('click', (event) => {
        if (event.target === accountModal) {
            accountModal.style.display = 'none';
        }
        if (event.target === document.getElementById('mfa-setup-modal')) {
            document.getElementById('mfa-setup-modal').style.display = 'none';
        }
    });

    // --- MFA Logic ---
    const setupMfaBtn = document.getElementById('setup-mfa-btn');
    const mfaSetupModal = document.getElementById('mfa-setup-modal');
    const closeMfaSetupBtn = document.getElementById('close-mfa-setup-modal');
    const mfaQrCode = document.getElementById('mfa-qr-code');
    const mfaSetupOtp = document.getElementById('mfa-setup-otp');
    const confirmMfaBtn = document.getElementById('confirm-mfa-btn');
    const mfaSetupError = document.getElementById('mfa-setup-error');

    if (setupMfaBtn) {
        setupMfaBtn.addEventListener('click', async () => {
            try {
                const response = await fetch('/api/mfa/setup');

                if (response.status === 401) {
                    alert('Sessione scaduta. Verrai reindirizzato al login.');
                    window.location.href = '/login';
                    return;
                }

                let data;
                try {
                    data = await response.json();
                } catch (jsonErr) {
                    console.error('Failed to parse MFA setup response as JSON:', jsonErr);
                    throw new Error('Risposta del server non valida.');
                }

                if (response.ok) {
                    mfaQrCode.src = data.qrCode;
                    mfaSetupModal.style.display = 'flex';
                    mfaSetupOtp.value = '';
                    mfaSetupError.style.display = 'none';
                } else {
                    alert(data.message || 'Errore inizializzazione MFA.');
                }
            } catch (err) {
                console.error('MFA Setup error:', err);
                alert('Errore di connessione o del server: ' + err.message);
            }
        });
    }

    if (closeMfaSetupBtn) {
        closeMfaSetupBtn.addEventListener('click', () => {
            mfaSetupModal.style.display = 'none';
        });
    }

    if (confirmMfaBtn) {
        confirmMfaBtn.addEventListener('click', async () => {
            const otp = mfaSetupOtp.value.trim();
            if (otp.length !== 6) {
                mfaSetupError.textContent = 'Inserisci un codice di 6 cifre.';
                mfaSetupError.style.display = 'block';
                return;
            }

            try {
                const response = await fetch('/api/mfa/enable', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ otp })
                });
                const data = await response.json();
                if (response.ok) {
                    alert('MFA abilitato con successo!');
                    mfaSetupModal.style.display = 'none';
                    // Qui potresti aggiornare la UI se necessario
                } else {
                    mfaSetupError.textContent = data.message || 'Errore durante l\'abilitazione.';
                    mfaSetupError.style.display = 'block';
                }
            } catch (err) {
                console.error('MFA Enable error:', err);
                mfaSetupError.textContent = 'Errore di connessione.';
                mfaSetupError.style.display = 'block';
            }
        });
    }

    const aiutoBtn = document.getElementById('aiuto-button');
    if (aiutoBtn) aiutoBtn.style.display = 'none';


    selectAllCheckbox.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const allCheckboxes = document.querySelectorAll('.email-item input[type="checkbox"], .pair-box input[type="checkbox"]');
        allCheckboxes.forEach(checkbox => {
            checkbox.checked = isChecked;
            const emailItem = checkbox.closest('.email-item');
            if (emailItem) {
                const id = emailItem.dataset.id;
                if (isChecked) selectedEmailIds.add(id);
                else selectedEmailIds.delete(id);
            }
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
        } else if (activeTab === 'cloud-monitor-tab') {
            viewId = 'cloud-monitor-view';
        } else if (activeTab === 'show-pinned-emails') {
            viewId = 'pinned-view';
        }

        if (viewId) {
            const view = document.getElementById(viewId);
            const allCheckboxes = view.querySelectorAll('.email-item input[type="checkbox"], .pair-box input[type="checkbox"]');
            allCheckboxes.forEach(checkbox => {
                checkbox.checked = isChecked;
                const emailItem = checkbox.closest('.email-item');
                if (emailItem) {
                    const id = emailItem.dataset.id;
                    if (isChecked) selectedEmailIds.add(id);
                    else selectedEmailIds.delete(id);
                }
                if (checkbox.closest('.pair-box')) {
                    const changeEvent = new Event('change');
                    checkbox.dispatchEvent(changeEvent);
                }
            });
        }
    });

    const emailSearchInput = document.getElementById('email-search-input');
    emailSearchInput.addEventListener('input', () => {
        rerenderEmails();
    });

    selectUselessCheckbox.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const emailItems = document.querySelectorAll('.email-item');
        emailItems.forEach(item => {
            const checkbox = item.querySelector('input[type="checkbox"]');
            const emailId = item.dataset.id;
            const email = allEmails.find(e => e.id === emailId);
            const isLowScore = email && email.score <= 0.49;

            if (isChecked) {
                checkbox.checked = isLowScore;
                if (isLowScore) selectedEmailIds.add(emailId);
            } else {
                checkbox.checked = false;
                selectedEmailIds.delete(emailId);
            }
        });

        // After setting individual email checkboxes, check pair-box checkboxes if any of their contained emails are selected
        const pairBoxes = document.querySelectorAll('.pair-box');
        pairBoxes.forEach(pairBox => {
            const pairCheckbox = pairBox.querySelector('.pair-checkbox');
            if (isChecked) {
                const emailIdsInGroup = pairBox.dataset.emailIds.split(',');
                const allEmailsInGroup = allEmails.filter(email => emailIdsInGroup.includes(email.id));
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
        currentSortMode = 'score';
        updateSortUI();
        applySorting();
        rerenderEmails();
    });

    sortDateButton.addEventListener('click', () => {
        currentSortMode = 'date';
        updateSortUI();
        applySorting();
        rerenderEmails();
    });

    function applySorting() {
        if (currentSortMode === 'score') {
            allEmails.sort((a, b) => b.score - a.score);
        } else {
            allEmails.sort((a, b) => (parseInt(b.internalDate, 10) || 0) - (parseInt(a.internalDate, 10) || 0));
        }
    }

    function updateSortUI() {
        sortScoreButton.classList.toggle('active', currentSortMode === 'score');
        sortDateButton.classList.toggle('active', currentSortMode === 'date');
    }

    // Imposta lo stato iniziale della UI di sorting
    updateSortUI();

    markReadButton.addEventListener('click', () => handleMarkAction('read'));



    async function handleMarkAction(action) {
        const selectedCheckboxes = document.querySelectorAll('.email-item input[type="checkbox"]:checked');
        const emailIds = Array.from(selectedCheckboxes).map(cb => cb.closest('.email-item').dataset.id);

        if (emailIds.length === 0) {
            alert(`Seleziona almeno un'email.`);
            return;
        }

        const emailsToSend = allEmails.filter(e => emailIds.includes(e.id));
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
        const email = allEmails.find(e => e.id === emailId);
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

    // --- Google Chat Logic ---
    async function fetchChatSpaces() {
        try {
            console.log('Fetching chat spaces from /api/chat/spaces...');
            const response = await fetch('/api/chat/spaces');
            if (!response.ok) throw new Error('Failed to fetch chat spaces');
            const data = await response.json();
            console.log(`Received ${data.spaces.length} chat spaces.`);
            if (data.myId) {
                myChatId = data.myId;
                console.log(`My Google Chat ID: ${myChatId}`);
            }
            renderChatSpaces(data.spaces);
        } catch (error) {
            console.error('Error fetching chat spaces:', error);
        }
    }

    function renderChatSpaces(spaces) {
        const container = document.getElementById('chat-spaces-list');
        container.innerHTML = '';

        if (spaces.length === 0) {
            container.innerHTML = '<p class="text-center p-3 text-muted">Nessuna conversazione trovata.</p>';
            return;
        }

        spaces.forEach(space => {
            const div = document.createElement('div');
            div.className = `chat-space-item ${activeSpaceId === space.name.split('/')[1] ? 'active' : ''}`;
            const spaceId = space.name.split('/')[1];

            // Per i DM spesso il nome è 'directMessage'
            const displayName = space.displayName || 'Direct Message';

            div.innerHTML = `
                <div class="chat-space-icon"><i class="fa-solid fa-user"></i></div>
                <div class="chat-space-name">${DOMPurify.sanitize(displayName)}</div>
            `;

            div.addEventListener('click', () => {
                document.querySelectorAll('.chat-space-item').forEach(el => el.classList.remove('active'));
                div.classList.add('active');
                activeSpaceId = spaceId;
                document.getElementById('active-chat-name').textContent = displayName;
                fetchChatMessages(spaceId);

                // Reset refresh timer
                if (chatRefreshTimer) clearInterval(chatRefreshTimer);
                chatRefreshTimer = setInterval(() => fetchChatMessages(spaceId, true), 5000);
            });

            container.appendChild(div);
        });
    }

    async function fetchChatMessages(spaceId, isSilent = false) {
        if (!spaceId) return;

        // Use preloaded cache if available for the first load
        if (!isSilent && window.__CHAT_CACHE__ && window.__CHAT_CACHE__[spaceId]) {
            console.log(`Using cached messages for space ${spaceId}`);
            renderChatMessages(window.__CHAT_CACHE__[spaceId], window.__MEMBERS_MAP_CACHE__[spaceId] || {}, false);
            // Delete from cache so next manual fetch is real, but keep for this tick
            // Actually, we want to refresh in background anyway
        }

        try {
            const response = await fetch(`/api/chat/messages/${spaceId}`);
            if (!response.ok) throw new Error('Failed to fetch chat messages');
            const data = await response.json();
            renderChatMessages(data.messages, data.membersMap, isSilent);

            // Update cache for next time
            if (!window.__CHAT_CACHE__) window.__CHAT_CACHE__ = {};
            if (!window.__MEMBERS_MAP_CACHE__) window.__MEMBERS_MAP_CACHE__ = {};
            window.__CHAT_CACHE__[spaceId] = data.messages;
            window.__MEMBERS_MAP_CACHE__[spaceId] = data.membersMap;
        } catch (error) {
            console.error('Error fetching chat messages:', error);
        }
    }

    function renderChatMessages(messages, membersMap = {}, isSilent = false) {
        const container = document.getElementById('chat-messages-container');
        const shouldScroll = !isSilent || (container.scrollTop + container.clientHeight >= container.scrollHeight - 50);

        container.innerHTML = '';

        // Google Chat restituisce messaggi in ordine cronologico.
        messages.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));

        let hasNewMessages = false;

        messages.forEach(msg => {
            // Google annotates users differently, rely on the clean "myChatId" mapping
            const senderUserId = msg.sender?.name || '';
            const isMine = (senderUserId === myChatId) || (msg.sender && msg.sender.email === accountEmail);
            const div = document.createElement('div');
            div.className = `chat-message ${isMine ? 'message-mine' : 'message-others'}`;

            const senderName = msg.sender?.displayName || membersMap[senderUserId] || 'Unknown';
            const time = new Date(msg.createTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            let messageContent = DOMPurify.sanitize(msg.text || '');
            let hasImage = false;

            // Handle attachments
            if (msg.attachment && msg.attachment.length > 0) {
                msg.attachment.forEach(att => {
                    if (att.attachmentDataRef && att.contentName) {
                        const isImage = att.contentType && att.contentType.startsWith('image/');
                        if (isImage) {
                            hasImage = true;
                            messageContent += `<div class="chat-image-container"><img class="chat-image" src="/api/chat/media/${encodeURIComponent(att.attachmentDataRef.resourceName)}" alt="${DOMPurify.sanitize(att.contentName)}" /></div>`;
                        } else {
                            messageContent += `<div class="chat-file-attachment"><i class="fa-solid fa-file"></i> <a href="/api/chat/media/${encodeURIComponent(att.attachmentDataRef.resourceName)}" target="_blank">${DOMPurify.sanitize(att.contentName)}</a></div>`;
                        }
                    } else if (att.driveDataRef) {
                        messageContent += `<div class="chat-drive-attachment"><i class="fa-brands fa-google-drive"></i> <a href="https://drive.google.com/open?id=${encodeURIComponent(att.driveDataRef.driveFileId)}" target="_blank">Google Drive File</a></div>`;
                    }
                });
            }

            div.innerHTML = `
                ${!isMine ? `<div class="message-sender">${DOMPurify.sanitize(senderName)}</div>` : ''}
                <div class="message-text">${messageContent}</div>
                <span class="message-time">${time}</span>
            `;
            container.appendChild(div);

            // Handle Notifications
            if (!seenChatMessageIds.has(msg.name)) {
                seenChatMessageIds.add(msg.name);
                // If it's silent (meaning it's an auto-refresh) and it's not my own message, trigger notification and badge
                if (isSilent && !isMine) {
                    hasNewMessages = true;
                    let notifText = msg.text || '';
                    if (hasImage) {
                        notifText = '(Immagine) ' + notifText;
                    } else if (msg.attachment && msg.attachment.length > 0) {
                        notifText = '(Allegato) ' + notifText;
                    }
                    showChatNotification(senderName, notifText);
                }
            }
        });

        // Update badge if chat panel is not open
        if (hasNewMessages) {
            const chatPanel = document.getElementById('chat-panel');
            if (chatPanel && chatPanel.style.display !== 'flex') {
                const chatBadge = document.getElementById('chat-badge');
                if (chatBadge) chatBadge.style.display = 'inline-block';
            }
        }

        if (shouldScroll) {
            container.scrollTop = container.scrollHeight;
        }
    }

    async function sendChatMessage() {
        const input = document.getElementById('chat-message-input');
        const text = input.value.trim();
        if (!text || !activeSpaceId) return;

        input.value = '';
        input.disabled = true;

        try {
            const response = await fetch('/api/chat/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ spaceId: activeSpaceId, text: text })
            });

            if (!response.ok) throw new Error('Failed to send message');

            // Refresh messages immediately
            fetchChatMessages(activeSpaceId, true);
        } catch (error) {
            console.error('Error sending message:', error);
            alert('Errore durante l\'invio del messaggio.');
        } finally {
            input.disabled = false;
            input.focus();
        }
    }

    async function evaluateImportanceWithGemini() {
        const apiKey = document.getElementById('gemini-api-key').value;
        if (!apiKey) {
            alert("Inserisci l'API Key di Gemini.");
            return;
        }

        if (allEmails.length === 0) {
            alert("Nessuna email da valutare.");
            return;
        }

        const emailIds = allEmails.map(e => e.id);

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
                    const index = allEmails.findIndex(e => e.id === updatedEmail.id);
                    if (index !== -1) {
                        allEmails[index].score = updatedEmail.score;
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

    async function fetchAndDisplayEmails(isSilent = false) {
        if (!isSilent) {
            loadingSpinner.style.display = 'block';
            loadingMessage.style.display = 'block';
            loadingMessage.textContent = 'Sto scaricando le email dal server...';
        }

        const limit = emailLimitSelect.value;
        let errorOccurred = false;

        try {
            const response = await fetch(`/api/emails?limit=${limit}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();

            // Check for real changes to prevent flickering
            const newEmails = data.emails || [];
            const newLabelMap = data.labelMap || {};
            const newAccountEmail = data.accountEmail || '';

            const emailsChanged = newEmails.length !== allEmails.length ||
                newEmails.some((e, i) => e.id !== allEmails[i]?.id);
            const labelsChanged = JSON.stringify(newLabelMap) !== JSON.stringify(labelMap);
            const accountEmailChanged = newAccountEmail !== accountEmail;

            if (!emailsChanged && !labelsChanged && !accountEmailChanged) {
                return;
            }

            allEmails = newEmails;
            labelMap = newLabelMap;
            accountEmail = newAccountEmail;

            updateCategorySelect(labelMap);
            applySorting();

            if (!isSilent) {
                loadingMessage.textContent = `Scaricamento completato. Analizzando ${allEmails.length} email con l\'LLM...`;
            }
            rerenderEmails();
            updateEmailStatus(true); // Imposta lo stato su OK (verde)

        } catch (error) {
            console.error('Error fetching emails:', error);
            updateEmailStatus(false, 'Errore di connessione a Gmail'); // Imposta lo stato su Error (rosso)
            errorOccurred = true;
        } finally {
            if (!isSilent) {
                loadingSpinner.style.display = 'none';
                if (!errorOccurred) { // Only hide and clear message if no error occurred
                    loadingMessage.style.display = 'none';
                    loadingMessage.textContent = '';
                }
            }
        }
    }



    async function fetchRedmineIssues(isSilent = false) {
        try {
            const response = await fetch('/api/redmine/issues');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            cloudMonitorIssues = await response.json();
            rerenderEmails();
        } catch (error) {
            console.error('Error fetching Redmine issues:', error);
        }
    }

    function rerenderEmails() {
        const searchTerm = document.getElementById('email-search-input').value.toLowerCase();
        const categoryFilter = document.getElementById('gmail-category-select').value;

        let filteredEmails = allEmails;

        // Criterio di ricerca testuale
        if (searchTerm) {
            filteredEmails = filteredEmails.filter(e =>
                (e.subject && e.subject.toLowerCase().includes(searchTerm)) ||
                (e.from && e.from.toLowerCase().includes(searchTerm)) ||
                (e.snippet && e.snippet.toLowerCase().includes(searchTerm))
            );
        }

        // Filtro per categoria Gmail
        if (categoryFilter !== 'ALL') {
            filteredEmails = filteredEmails.filter(e => e.labelIds && e.labelIds.includes(categoryFilter));
        }

        // Filter Cloud Monitor Issues based on hours
        const selectedHours = parseInt(document.getElementById('cloud-hours-select').value, 10);
        const threshold = Date.now() - (selectedHours * 60 * 60 * 1000);

        const filteredCloudIssues = cloudMonitorIssues.filter(issue => {
            const issueDate = new Date(issue.created_on).getTime();
            return issueDate >= threshold;
        });

        // Dividi in Cloud Monitor, Human e Bot
        const cloudMonitorEmails = filteredEmails.filter(e => e.from && e.from.includes('Cloud Monitor'));
        const otherEmails = filteredEmails.filter(e => !cloudMonitorEmails.includes(e));

        const humanEmails = otherEmails.filter(e => e.category === 'Human');
        const botEmails = otherEmails.filter(e => e.category === 'Bot');

        emailStats.textContent = `Email non lette: ${filteredEmails.length} (Human: ${humanEmails.length}, Bot: ${botEmails.length}, Redmine: ${filteredCloudIssues.length})`

        document.getElementById('human-count').textContent = humanEmails.length;
        document.getElementById('bot-count').textContent = botEmails.length;
        document.getElementById('cloud-monitor-count').textContent = filteredCloudIssues.length;

        displayEmails(humanEmails, humanEmailListContainer, humanHighlightedEmailsContainer, false);
        displayEmails(botEmails, botEmailListContainer, botHighlightedEmailsContainer, true);

        displayCloudMonitorEmails(filteredCloudIssues);
        renderStickyNotes(pinnedEmails);
    }

    function renderStickyNotes(pinnedEmails) {
        const container = document.getElementById('sticky-notes-container');
        if (!container) return;

        if (!pinnedEmails || pinnedEmails.length === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        // Keep track of current notes in DOM to avoid re-animating
        const existingNotes = Array.from(container.querySelectorAll('.sticky-note'));
        const activeIds = new Set(pinnedEmails.map(e => e.id));

        // Remove notes that are no longer pinned
        existingNotes.forEach(note => {
            if (!activeIds.has(note.dataset.id)) {
                note.remove();
            }
        });

        pinnedEmails.forEach((email, index) => {
            let note = container.querySelector(`.sticky-note[data-id="${email.id}"]`);
            const isNew = !note;

            if (isNew) {
                note = document.createElement('div');
                note.dataset.id = email.id;
                container.appendChild(note);
            }

            // Deterministic color and rotation based on email ID
            const idHash = email.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
            const colorIndex = Math.abs(idHash) % 6;
            note.className = `sticky-note note-color-${colorIndex}`;

            // Deterministic rotation for stability
            const rotation = ((Math.abs(idHash) % 41) / 10 - 2).toFixed(1);
            note.style.transform = `rotate(${rotation}deg)`;

            const date = new Date(parseInt(email.internalDate, 10));
            const dateStr = date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

            // Only update innerHTML if it's new or something changed (simplified: update always but it won't trigger transition)
            note.innerHTML = `
                <button class="note-pin" title="Unpin"><i class="fa-solid fa-thumbtack"></i></button>
                <div class="note-from">${DOMPurify.sanitize(email.from)}</div>
                <div class="note-subject">${DOMPurify.sanitize(email.subject)}</div>
                <div class="note-preview">${DOMPurify.sanitize(email.snippet)}</div>
                <div class="note-date">${dateStr}</div>
            `;

            note.querySelector('.note-pin').addEventListener('click', (e) => {
                e.stopPropagation();
                unpinEmail(email.id);
            });

            note.onclick = () => openFullScreenEmail(email);
        });
    }

    function displayCloudMonitorEmails(cloudIssues) {
        const listContainer = document.getElementById('cloud-monitor-email-list-container');
        const highlightedContainer = document.getElementById('cloud-monitor-highlighted-emails-container');

        if (!listContainer || !highlightedContainer) return;

        listContainer.innerHTML = '';
        highlightedContainer.innerHTML = '';

        if (!cloudIssues || cloudIssues.length === 0) {
            listContainer.innerHTML = '<p>Nessuna issue da Redmine per l\'intervallo selezionato.</p>';
            return;
        }

        const serviceIssues = {};

        cloudIssues.forEach(issue => {
            // Map Redmine issue to email-like object for existing UI structure
            const mappedIssue = {
                id: issue.id,
                subject: issue.subject,
                from: 'Cloud Monitor',
                snippet: issue.description.substring(0, 100),
                body: issue.description,
                internalDate: new Date(issue.created_on).getTime().toString(),
                redmineTicketId: issue.id
            };

            // Attempt to extract service from description

            const body = mappedIssue.body;

            let match = body.match(/Corpo:[\s\S]*?Service:\s*(.+)\r?\n/i);
            let service = match ? match[1].trim() : null;

            if (!service) {
                const m2 = body.match(/Snippet:.*?Service:\s*(.*?)\s*Host:/i);
                service = m2 ? m2[1].trim() : 'Generic';
            }

            service = service.replace(/^Service\s+/i, '').trim();








            if (!serviceIssues[service]) serviceIssues[service] = [];
            serviceIssues[service].push(mappedIssue);
        });

        const sortedServices = Object.keys(serviceIssues).sort();
        sortedServices.forEach(service => {
            const group = serviceIssues[service];
            const groupElement = createCloudGroupElement(group, `Service: ${service}`, 'fa-folder-open');
            highlightedContainer.appendChild(groupElement);
        });
    }


    function createCloudGroupElement(group, groupKey, folderIconClass) {
        const folder = document.createElement('div');
        folder.className = 'cloud-folder';

        const header = document.createElement('div');
        header.className = 'cloud-folder-header';
        header.innerHTML = `<i class="fa-solid ${folderIconClass}"></i> <span>${groupKey} (${group.length})</span>`;

        const filesContainer = document.createElement('div');
        filesContainer.className = 'cloud-files-container';

        // Restore folder state
        const isFolderOpen = cloudMonitorState.openFolders.has(groupKey);
        filesContainer.style.display = isFolderOpen ? 'block' : 'none';
        if (isFolderOpen) header.classList.add('open');

        header.addEventListener('click', () => {
            const isVisible = filesContainer.style.display === 'block';
            filesContainer.style.display = isVisible ? 'none' : 'block';
            header.classList.toggle('open', !isVisible);

            // Persist folder state
            if (!isVisible) {
                cloudMonitorState.openFolders.add(groupKey);
            } else {
                cloudMonitorState.openFolders.delete(groupKey);
            }
        });

        group.sort((a, b) => b.internalDate - a.internalDate).forEach(email => {
            const file = document.createElement('div');
            file.className = 'cloud-file';

            const fileHeader = document.createElement('div');
            fileHeader.className = 'cloud-file-header';

            const date = new Date(parseInt(email.internalDate, 10));
            const dateStr = date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

            fileHeader.innerHTML = `
                <i class="fa-solid fa-file-lines"></i>
                <span class="file-date">[${dateStr}]</span>
                <span class="file-subject" style="display: flex; align-items: center; gap: 8px;">
                    ${email.subject} 
                    ${email.hasNotes ? '<span class="note-indicator-badge" title="Note presenti"><i class="fa-solid fa-note-sticky"></i></span>' : ''}
                </span>
            `;

            const fileDetails = document.createElement('div');
            fileDetails.className = 'cloud-file-details';

            // Restore file details state
            const isFileOpen = cloudMonitorState.openFiles.has(email.id);
            fileDetails.style.display = isFileOpen ? 'block' : 'none';
            if (isFileOpen) fileHeader.classList.add('open');

            // Extract more info for details
            const body = email.bodyHtml || email.body || '';

            // HOST: prende il testo nella seconda <td> dopo "Host:" o cerca Host: in testo piano
            const hostMatch = body.match(/Host:\s*<\/td>[\s\S]*?<td[^>]*>\s*([^<\s][^<]*)\s*<\/td>/i) ||
                body.match(/Host:\s*([^<\n\r]+?)(?=\s+(?:Event|Address|Site|Summary|Status|Snippet:)|$)/i) ||
                body.match(/Host:\s*([^\n\r<]+)/i);
            const host = hostMatch ? hostMatch[1].trim() : 'N/A';

            // STATUS/ EVENT: cerca uno degli stati consentiti dentro i "badge" di Event o cerca Event: in testo piano
            const statusMatch = body.match(/Event:[\s\S]*?<div[^>]*>\s*(OK|CRIT|WARN|UNKNOWN|UP|DOWN)\s*<\/div>/i) ||
                body.match(/Event:\s*(?:.*?[–\->›]+\s*)?(OK|CRIT|WARN|UNKNOWN|UP|DOWN)\b/i) ||
                body.match(/\b(OK|CRIT|WARN|UNKNOWN|UP|DOWN)\b/i);
            const status = statusMatch ? (statusMatch[1] || statusMatch[0]).trim() : 'N/A';

            fileDetails.innerHTML = `
                <div class="detail-row"><strong>Host:</strong> ${host}</div>
                <div class="detail-row"><strong>Status:</strong> <span class="status-badge status-${status.toLowerCase()}">${status}</span></div>

                <div class="detail-row"><strong>Snippet:</strong> ${email.snippet}</div>
                <div class="detail-actions">
                    <button class="btn btn-sm btn-outline-info view-full-cloud">Leggi Tutto</button>
                    ${email.redmineTicketId ? `
                        <button class="btn btn-sm btn-success close-redmine-cloud" data-ticket-id="${email.redmineTicketId}" data-email-id="${email.id}">
                            <i class="fa-solid fa-check"></i> Chiudi Ticket
                        </button>
                    ` : ''}
                </div>
            `;

            fileDetails.querySelector('.view-full-cloud').addEventListener('click', (e) => {
                e.stopPropagation();
                openFullScreenEmail(email);
            });

            if (fileDetails.querySelector('.create-redmine-cloud')) {
                fileDetails.querySelector('.create-redmine-cloud').addEventListener('click', (e) => {
                    e.stopPropagation();
                    openRedmineModal(email);
                });
            }

            if (fileDetails.querySelector('.close-redmine-cloud')) {
                fileDetails.querySelector('.close-redmine-cloud').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const ticketId = e.currentTarget.dataset.ticketId;
                    const emailId = e.currentTarget.dataset.emailId;

                    if (confirm('Sei sicuro di voler chiudere il ticket?')) {
                        try {
                            const response = await fetch('/api/redmine/close-ticket', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ ticketId, emailId })
                            });

                            if (response.ok) {
                                alert('Ticket chiuso con successo.');
                                // Aggiorna la UI locale se necessario, o ricarica le email
                                fetchAndDisplayEmails(true);
                            } else {
                                const error = await response.text();
                                alert('Errore durante la chiusura del ticket: ' + error);
                            }
                        } catch (err) {
                            console.error('Error closing ticket:', err);
                            alert('Errore di connessione durante la chiusura del ticket.');
                        }
                    }
                });
            }

            fileHeader.addEventListener('click', () => {
                const isVisible = fileDetails.style.display === 'block';
                fileDetails.style.display = isVisible ? 'none' : 'block';
                fileHeader.classList.toggle('open', !isVisible);

                // Persist file state
                if (!isVisible) {
                    cloudMonitorState.openFiles.add(email.id);
                } else {
                    cloudMonitorState.openFiles.delete(email.id);
                }
            });

            file.appendChild(fileHeader);
            file.appendChild(fileDetails);
            filesContainer.appendChild(file);
        });

        folder.appendChild(header);
        folder.appendChild(filesContainer);
        return folder;
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

        const checkboxContainer = document.createElement('div');
        checkboxContainer.className = 'checkbox-wrapper';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedEmailIds.has(email.id);
        checkbox.addEventListener('click', e => e.stopPropagation());
        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) selectedEmailIds.add(email.id);
            else selectedEmailIds.delete(email.id);
        });
        checkboxContainer.appendChild(checkbox);

        if (email.hasNotes) {
            const noteBadge = document.createElement('div');
            noteBadge.className = 'note-indicator-badge';
            noteBadge.innerHTML = '<i class="fa-solid fa-note-sticky"></i>';
            noteBadge.title = 'Questa email ha delle note';
            checkboxContainer.appendChild(noteBadge);
        }
        mainContent.appendChild(checkboxContainer);

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

        if (email.labelIds && email.labelIds.length > 0) {
            const labelsContainer = document.createElement('div');
            labelsContainer.className = 'labels-container';
            email.labelIds.forEach(label => {
                // Ignore internal/redundant labels for UI
                if (['UNREAD'].includes(label)) return;

                const badge = document.createElement('span');
                badge.className = `label-badge label-${label.toLowerCase().replace(/_/g, '-')}`;
                badge.textContent = labelMap[label] || label;
                labelsContainer.appendChild(badge);
            });
            emailDetails.appendChild(labelsContainer);
        }

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
        replyButton.innerHTML = '<i class="fa-solid fa-reply"></i>';
        replyButton.title = 'Reply to this email';

        replyButton.addEventListener('click', (e) => {
            e.stopPropagation(); // ESSENTIAL: Stop the click from opening the email body
            openReplyModal(email); // Manually open our custom modal
        });

        cardActions.appendChild(replyButton);

        const redmineBtn = document.createElement('button');
        redmineBtn.className = 'btn btn-sm btn-redmine redmine-list-button';
        redmineBtn.innerHTML = '<i class="fa-solid fa-ticket"></i>';
        redmineBtn.title = 'Crea Ticket Redmine';
        redmineBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openRedmineModal(email);
        });
        cardActions.appendChild(redmineBtn);

        const l1Btn = document.createElement('button');
        l1Btn.className = 'btn btn-sm btn-assign-l1';
        l1Btn.innerHTML = 'L1 Support';
        l1Btn.title = 'Assegna al Supporto Livello 1 (Progetto Maestrale Cloud)';
        l1Btn.addEventListener('click', (e) => {
            e.stopPropagation();
            assignToLevel1(email, l1Btn);
        });
        cardActions.appendChild(l1Btn);

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

        // Restore expanded state
        const isExpanded = expandedEmailIds.has(email.id);
        body.style.display = isExpanded ? 'block' : 'none';

        listItem.appendChild(body);

        listItem.addEventListener('click', () => {
            const isVisible = body.style.display === 'block';
            body.style.display = isVisible ? 'none' : 'block';

            // Persist expanded state
            if (!isVisible) {
                expandedEmailIds.add(email.id);
            } else {
                expandedEmailIds.delete(email.id);
            }
        });

        return listItem;
    }

    function pinEmail(emailId) {
        const emailIndex = allEmails.findIndex(e => e.id === emailId);
        if (emailIndex > -1) {
            const [pinnedEmail] = allEmails.splice(emailIndex, 1);
            pinnedEmails.push(pinnedEmail);
            rerenderEmails();
        }
    }

    function unpinEmail(emailId) {
        const emailIndex = pinnedEmails.findIndex(e => e.id === emailId);
        if (emailIndex > -1) {
            const [unpinnedEmail] = pinnedEmails.splice(emailIndex, 1);
            allEmails.push(unpinnedEmail);
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
        if (!autoRefreshSelect) return;
        const interval = parseInt(autoRefreshSelect.value, 10);

        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }

        if (interval > 0) {
            refreshTimer = setInterval(fetchAndDisplayEmails, interval * 1000);
        }
    }

    // autoRefreshSelect.addEventListener('change', setupAutoRefresh); // REMOVED
    emailLimitSelect.addEventListener('change', () => fetchAndDisplayEmails(false));

    const gmailCategorySelect = document.getElementById('gmail-category-select');
    if (gmailCategorySelect) {
        gmailCategorySelect.addEventListener('change', () => rerenderEmails());
    }

    const cloudHoursSelect = document.getElementById('cloud-hours-select');
    if (cloudHoursSelect) {
        cloudHoursSelect.addEventListener('change', () => rerenderEmails());
    }

    // Manual Refresh Button
    const manualRefreshBtn = document.getElementById('refresh-emails-btn');
    if (manualRefreshBtn) {
        manualRefreshBtn.addEventListener('click', () => {
            fetchAndDisplayEmails(false);
            fetchRedmineIssues(true);
            const icon = manualRefreshBtn.querySelector('i');
            if (icon) {
                icon.classList.add('fa-spin');
                setTimeout(() => icon.classList.remove('fa-spin'), 1000);
            }
        });
    }

    // Silent background refresh every 10 seconds
    setInterval(() => {
        fetchAndDisplayEmails(true);
        fetchRedmineIssues(true);
    }, 10000);

    fetchAndDisplayEmails(false);
    fetchRedmineIssues(false);

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
            const data = await response.json();
            totalLines = data.totalLines;
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
            const response = await fetch(`/api/classifier-health`);
            if (!llmStatusIndicator) return;

            if (response.ok) {
                const data = await response.json();
                if (data.status === 'ok') {
                    llmStatusIndicator.classList.remove('error');
                    llmStatusIndicator.classList.add('operational');
                    llmStatusIndicator.title = 'classifier operational';
                } else {
                    llmStatusIndicator.classList.remove('operational');
                    llmStatusIndicator.classList.add('error');
                    llmStatusIndicator.title = 'classifier is not responding';
                }
            } else {
                llmStatusIndicator.classList.remove('operational');
                llmStatusIndicator.classList.add('error');
                llmStatusIndicator.title = 'classifier is not responding';
            }
        } catch (error) {
            console.error('Error checking LLM status:', error);
            if (llmStatusIndicator) {
                llmStatusIndicator.classList.remove('operational');
                llmStatusIndicator.classList.add('error');
                llmStatusIndicator.title = 'classifier is not responding';
            }
        } finally {
            updateStatusFace();
        }
    }

    function updateEmailStatus(success, message) {
        const emailStatusIndicator = document.getElementById('email-status');
        if (!emailStatusIndicator) return;

        if (success) {
            emailStatusIndicator.classList.remove('error');
            emailStatusIndicator.classList.add('operational');
            emailStatusIndicator.title = message || 'Gmail connected and syncing';
        } else {
            emailStatusIndicator.classList.remove('operational');
            emailStatusIndicator.classList.add('error');
            emailStatusIndicator.title = message || 'Gmail connection error';
        }
        updateStatusFace();
    }

    function updateStatusFace() {
        const emailOk = document.getElementById('email-status').classList.contains('operational');
        const llmOk = document.getElementById('llm-status').classList.contains('operational');
        const mouth = document.getElementById('status-mouth');
        if (!mouth) return;

        if (emailOk && llmOk) {
            mouth.classList.remove('sad');
            mouth.classList.add('happy');
        } else if (document.getElementById('email-status').classList.contains('error') ||
            document.getElementById('llm-status').classList.contains('error')) {
            mouth.classList.remove('happy');
            mouth.classList.add('sad');
        } else {
            // Default/Gray state
            mouth.classList.remove('happy', 'sad');
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

    if (toggleNotesPanelButton) {
        toggleNotesPanelButton.addEventListener('click', () => {
            notesPanel.classList.toggle('open');
            if (notesPanel.classList.contains('open') && notes.length === 0) {
                fetchNotes();
            }
        });
    }

    if (closeNotesPanelButton) {
        closeNotesPanelButton.addEventListener('click', () => {
            notesPanel.classList.remove('open');
        });
    }

    if (noteSelector) {
        noteSelector.addEventListener('change', displaySelectedNote);
    }

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
            selector: '#accountDropdown',
            text: 'Accedi alle impostazioni del tuo account, cambia tema, scegli la modalità di visualizzazione o effettua il logout.',
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

    if (aiutoButton) aiutoButton.addEventListener('click', startWalkthrough);
    if (walkthroughNext) {
        walkthroughNext.addEventListener('click', () => {
            if (currentWalkthroughStep === walkthroughSteps.length - 1) {
                endWalkthrough();
            } else {
                showWalkthroughStep(currentWalkthroughStep + 1);
            }
        });
    }
    if (walkthroughEnd) walkthroughEnd.addEventListener('click', endWalkthrough);

    // Close walkthrough if overlay is clicked
    if (walkthroughOverlay) walkthroughOverlay.addEventListener('click', endWalkthrough);

    const fullEmailModal = document.getElementById('full-email-modal');
    function openFullScreenEmail(email) {
        console.log('--- Opening Full Screen Email ---', email.id);
        const modal = document.getElementById('full-email-modal');
        const bodyContainer = document.getElementById('full-email-body');
        bodyContainer.innerHTML = '';
        modal.style.display = 'flex'; // Use flex to respect CSS centering logic

        if (viewMode === 'gmail') {
            if (!email.threadId || !email.id) {
                console.error('Missing threadId or emailId for Gmail view:', email);
                bodyContainer.innerHTML = '<div class="alert alert-warning">Errore: ID mancanti per la visualizzazione Gmail. Prova a ricaricare la lista delle email.</div>';
                return;
            }

            // Gmail Deep-link construction
            // Using the email address in the URL forces Gmail to switch to the correct account
            // and using #all/${email.threadId} is the most standard permalink format.
            let gmailUrl = '';
            const emailPart = accountEmail ? `u/${accountEmail}/` : '';

            // Format 1: Standard permalink (most stable for specific account)
            gmailUrl = `https://mail.google.com/mail/${emailPart}#all/${email.threadId}`;

            const popoutWidth = 1150;
            const popoutHeight = 850;
            const left = (window.screen.width / 2) - (popoutWidth / 2);
            const top = (window.screen.height / 2) - (popoutHeight / 2);

            // Update modal UI first
            bodyContainer.innerHTML = `
                <div class="alert alert-info d-flex flex-row align-items-center p-4">
                    <div class="me-4">
                        <i class="fa-solid fa-envelope-open-text fa-4x text-primary"></i>
                    </div>
                    <div>
                        <h4>Visualizzazione Gmail</h4>
                        <p class="mb-2">L'email verrà aperta in una nuova finestra con l'account <strong>${accountEmail || 'predefinito'}</strong>.</p>
                        <button id="open-gmail-btn" class="btn btn-primary btn-lg">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> Apri su Gmail
                        </button>
                    </div>
                </div>
                <div id="popout-status" class="mt-3 text-center" style="display:none;">
                    <span class="text-warning small"><i class="fa-solid fa-circle-exclamation"></i> Se la finestra non si apre, abilita i popout nel browser per questo sito.</span>
                </div>
            `;

            const openGmail = () => {
                const popout = window.open(gmailUrl, '_blank', `width=${popoutWidth},height=${popoutHeight},left=${left},top=${top},scrollbars=yes,resizable=yes`);
                if (!popout || popout.closed || typeof popout.closed == 'undefined') {
                    document.getElementById('popout-status').style.display = 'block';
                }
            };

            // Attempt to open immediately but also rely on the button for 100% reliability
            setTimeout(openGmail, 100);

            document.getElementById('open-gmail-btn').addEventListener('click', openGmail);
        } else {
            // Native View
            const content = document.createElement('div');
            content.className = 'email-full-view';
            content.innerHTML = `
                <div class="email-meta-full">
                    <p><strong>Da:</strong> ${email.from}</p>
                    <p><strong>Oggetto:</strong> ${email.subject}</p>
                    <p><strong>Data:</strong> ${new Date(parseInt(email.internalDate, 10)).toLocaleString()}</p>
                </div>
                <hr>
                <div class="email-body-full">
                    ${email.bodyHtml ? DOMPurify.sanitize(email.bodyHtml) : `<pre>${email.body}</pre>`}
                </div>
            `;
            bodyContainer.appendChild(content);
        }

        // Add Redmine Button and other actions (Always visible)
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'email-actions';

        const redmineBtn = document.createElement('button');
        redmineBtn.className = 'btn btn-redmine btn-sm';
        redmineBtn.innerHTML = '<i class="fa-solid fa-ticket"></i> Crea Ticket Redmine';
        redmineBtn.onclick = () => openRedmineModal(email);

        actionsDiv.appendChild(redmineBtn);
        bodyContainer.appendChild(actionsDiv);

        // Load email notes
        loadEmailNotes(email.id);
    }

    // --- Redmine Modal Logic ---
    const redmineModal = document.getElementById('redmine-ticket-modal');
    const projectSelect = document.getElementById('redmine-project-select');
    const ticketSubjectInput = document.getElementById('redmine-ticket-subject');
    const ticketDescriptionInput = document.getElementById('redmine-ticket-description');
    const prioritySelect = document.getElementById('redmine-priority-select');
    const assigneeSelect = document.getElementById('redmine-assignee-select');
    const confirmTicketBtn = document.getElementById('confirm-redmine-ticket');
    const cancelTicketBtn = document.getElementById('cancel-redmine-ticket');
    const closeRedmineBtn = document.getElementById('close-redmine-modal');

    let currentEmailForTicket = null;

    async function openRedmineModal(email) {
        // Chiudi la modale "Leggi tutto" se è aperta
        closeFullScreenEmail();

        currentEmailForTicket = email;
        ticketSubjectInput.value = email.subject;
        ticketDescriptionInput.value = `Mittente: ${email.from}\n\nSnippet: ${email.snippet}\n\nCorpo:\n${email.body || email.snippet}`;

        // Reset defaults
        if (prioritySelect) prioritySelect.value = "2"; // Normale

        assigneeSelect.innerHTML = '<option value="">Seleziona un progetto...</option>';
        assigneeSelect.disabled = true;

        redmineModal.style.display = 'flex';

        // Fetch projects if not loaded
        if (projectSelect.options.length <= 1) {
            try {
                const response = await fetch('/api/redmine/projects');
                const projects = await response.json();
                projectSelect.innerHTML = '<option value="">Seleziona un progetto...</option>';
                projects.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.name;
                    projectSelect.appendChild(opt);
                });

                // If there's a default project (e.g. 7291 Maestrale Cloud), select it and load members
                const defaultProjectId = "7291";
                const hasDefault = projects.some(p => p.id === parseInt(defaultProjectId));
                if (hasDefault) {
                    projectSelect.value = defaultProjectId;
                    fetchAndPopulateRedmineMembers(defaultProjectId);
                } else {
                    assigneeSelect.innerHTML = '<option value="">Seleziona un progetto...</option>';
                }

            } catch (err) {
                console.error('Errore caricamento progetti:', err);
                alert('Errore nel caricamento della lista progetti Redmine.');
                assigneeSelect.innerHTML = '<option value="">Errore.</option>';
            }
        } else if (projectSelect.value) {
            // If modal re-opened and project already selected, refresh members
            fetchAndPopulateRedmineMembers(projectSelect.value);
            assigneeSelect.innerHTML = '<option value="">Seleziona un progetto...</option>';
            assigneeSelect.disabled = true;
        }
    }

    async function fetchAndPopulateRedmineMembers(projectId) {
        if (!projectId) {
            assigneeSelect.innerHTML = '<option value="">Seleziona un progetto...</option>';
            assigneeSelect.disabled = true;
            return;
        }

        assigneeSelect.disabled = true; // Stay disabled while loading
        assigneeSelect.innerHTML = '<option value="">Caricamento membri...</option>';
        try {
            const response = await fetch(`/api/redmine/members/${projectId}`);
            const members = await response.json();

            assigneeSelect.innerHTML = '<option value="">Nessuno</option>';
            assigneeSelect.disabled = false; // Enable after loading
            members.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.name;
                assigneeSelect.appendChild(opt);
            });

            // Default to Riccardo Ratini (ID 4) if present
            const ratini = members.find(m => m.id === 4 || m.name.toLowerCase().includes('ratini'));
            if (ratini) {
                assigneeSelect.value = ratini.id;
            } else {
                assigneeSelect.value = "";
            }
        } catch (err) {
            console.error('Errore caricamento membri:', err);
            assigneeSelect.innerHTML = '<option value="">Errore membri.</option>';
            assigneeSelect.disabled = true;
        }
    }

    if (projectSelect) {
        projectSelect.addEventListener('change', (e) => {
            fetchAndPopulateRedmineMembers(e.target.value);
        });
    }

    function closeRedmineModal() {
        redmineModal.style.display = 'none';
        currentEmailForTicket = null;
    }

    if (closeRedmineBtn) closeRedmineBtn.addEventListener('click', closeRedmineModal);
    if (cancelTicketBtn) cancelTicketBtn.addEventListener('click', closeRedmineModal);

    if (confirmTicketBtn) {
        confirmTicketBtn.addEventListener('click', async () => {
            const projectId = projectSelect.value;
            const subject = ticketSubjectInput.value;
            const description = ticketDescriptionInput.value;
            const priorityId = prioritySelect ? parseInt(prioritySelect.value, 10) : 2;
            const assignedToId = assigneeSelect ? parseInt(assigneeSelect.value, 10) : 4;

            if (!projectId) {
                alert('Per favore seleziona un progetto.');
                return;
            }

            confirmTicketBtn.disabled = true;
            confirmTicketBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Creazione...';

            try {
                const response = await fetch('/api/redmine/create-ticket', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        emailId: currentEmailForTicket.id,
                        projectId,
                        subject,
                        description,
                        priorityId,
                        assignedToId
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    const ticketId = result.ticketId;
                    const emailForNotification = currentEmailForTicket; // Capture before clearing

                    closeRedmineModal();
                    closeFullScreenEmail();
                    if (typeof refreshEmails === 'function') refreshEmails();

                    // Prompt for notification
                    setTimeout(() => {
                        if (confirm(`Ticket #${ticketId} creato con successo. Vuoi inviare la notifica via email al mittente?`)) {
                            openNotificationModal(ticketId, emailForNotification);
                        }
                    }, 500);
                } else {
                    const errorJson = await response.json();
                    console.error('Server error creating Redmine ticket:', errorJson);
                    throw new Error(errorJson.message || 'Errore nella creazione del ticket.');
                }
            } catch (err) {
                console.error('Catch error:', err);
                alert(`Errore durante la creazione del ticket: ${err.message}`);
            } finally {
                confirmTicketBtn.disabled = false;
                confirmTicketBtn.innerHTML = 'Crea Ticket';
            }
        });
    }

    function closeFullScreenEmail() {
        console.log('Executing closeFullScreenEmail');
        const modal = document.getElementById('full-email-modal');
        const bodyContainer = document.getElementById('full-email-body');
        modal.style.display = 'none';
        bodyContainer.innerHTML = '';
    }

    // --- Ticket Notification Modal Logic ---
    const notificationModal = document.getElementById('ticket-notification-modal');
    const notificationToInput = document.getElementById('notification-to');
    const notificationSubjectInput = document.getElementById('notification-subject');
    const notificationBodyInput = document.getElementById('notification-body');
    const sendNotificationBtn = document.getElementById('send-notification');
    const cancelNotificationBtn = document.getElementById('cancel-notification');
    const closeNotificationBtn = document.getElementById('close-notification-modal');
    let currentThreadIdForNotification = null;

    function openNotificationModal(ticketId, email) {
        if (!notificationModal || !email) {
            console.error("Missing notificationModal or email object", { ticketId, email });
            return;
        }

        // Estrazione email pulita dal campo "From"
        let senderEmail = email.from || "";
        const emailMatch = senderEmail.match(/<(.+?)>/);
        if (emailMatch) senderEmail = emailMatch[1];

        currentThreadIdForNotification = email.threadId;

        notificationToInput.value = senderEmail;
        notificationSubjectInput.value = `Presa in carico richiesta | Ticket #${ticketId}`;

        notificationBodyInput.value = `
        <p style="margin: 0 0 16px 0;">
            Gentile utente,
        </p>

        <p style="margin: 0 0 12px 0;">
            ti confermiamo che la tua richiesta è stata presa in carico ed è ora gestita con il ticket n. <strong>#${ticketId}</strong>.
        </p>

        <p style="margin: 0 0 12px 0;">
            Ti invitiamo a indicare questo numero di ticket in caso di successive comunicazioni con il servizio di supporto, così da permetterci una gestione più rapida ed efficace della tua segnalazione.
        </p>

        <p style="margin: 24px 0 4px 0;">
            Cordiali saluti,
        </p>
        <p style="margin: 0;">
            <strong>Supporto Maestrale</strong>
        </p>
        </div>
        <img src="https://www.maestrale.it/wp-content/uploads/2020/12/mg_logo.png" alt="Logo Maestrale" width="100">
        `;

        notificationModal.style.display = 'flex';

        // Focus the recipients field
        setTimeout(() => {
            notificationToInput.focus();
        }, 100);
    }

    function closeNotificationModal() {
        if (notificationModal) notificationModal.style.display = 'none';
    }

    if (closeNotificationBtn) closeNotificationBtn.addEventListener('click', closeNotificationModal);
    if (cancelNotificationBtn) cancelNotificationBtn.addEventListener('click', closeNotificationModal);

    if (sendNotificationBtn) {
        sendNotificationBtn.addEventListener('click', async () => {
            const to = notificationToInput.value;
            const subject = notificationSubjectInput.value;
            const body = notificationBodyInput.value;

            if (!to || !subject || !body) {
                alert('Tutti i campi sono obbligatori.');
                return;
            }

            sendNotificationBtn.disabled = true;
            sendNotificationBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Invio...';

            try {
                const response = await fetch('/api/send-ticket-notification', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        to,
                        subject,
                        body,
                        threadId: currentThreadIdForNotification
                    })
                });

                if (response.ok) {
                    alert('Notifica inviata con successo!');
                    closeNotificationModal();
                } else {
                    const error = await response.json();
                    throw new Error(error.message || 'Errore durante l\'invio della notifica.');
                }
            } catch (err) {
                console.error('Errore notifica:', err);
                alert(`Errore: ${err.message}`);
            } finally {
                sendNotificationBtn.disabled = false;
                sendNotificationBtn.innerHTML = 'Invia Email';
            }
        });
    }

    if (fullEmailModal) {
        const closeBtn = document.getElementById('close-full-email');
        if (closeBtn) {
            console.log('Attaching close listener to #close-full-email');
            closeBtn.addEventListener('click', (e) => {
                console.log('Close button clicked');
                e.preventDefault();
                e.stopPropagation();
                closeFullScreenEmail();
            });
        } else {
            console.error('Element #close-full-email not found!');
        }

        // Fallback: click on modal background to close
        fullEmailModal.addEventListener('click', (e) => {
            if (e.target === fullEmailModal) {
                console.log('Modal background clicked, closing...');
                closeFullScreenEmail();
            }
        });
    } else {
        console.error('Element #full-email-modal not found!');
    }

    // Close modal on escape key press
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('full-email-modal');
        if (e.key === 'Escape' && modal.style.display === 'flex') {
            closeFullScreenEmail();
        }
    });

    const toggleCalendarPanelButton = document.getElementById('toggle-calendar-panel');
    const calendarPanel = document.getElementById('calendar-panel');

    if (toggleCalendarPanelButton && calendarPanel) {
        toggleCalendarPanelButton.addEventListener('click', () => {
            calendarPanel.classList.toggle('open');
        });
    }

    // --- Logica Autenticazione (Logout) ---
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.addEventListener('click', async () => {
            if (!confirm('Sei sicuro di voler uscire?')) return;
            try {
                const response = await fetch('/api/logout', { method: 'POST' });
                if (response.ok) {
                    window.location.href = '/login.html';
                }
            } catch (error) {
                console.error('Errore logout:', error);
            }
        });
    }


    // ===================================
    // VIEW MODE SWITCHER
    // ===================================
    (function initViewModeSwitcher() {
        const viewButtons = document.querySelectorAll('.view-mode-switch .view-btn');
        const body = document.body;

        if (viewButtons.length === 0) {
            console.warn('View mode buttons not found');
            return;
        }

        // Carica vista salvata o usa default (compact)
        const savedView = localStorage.getItem('emailViewMode') || 'compact';
        body.classList.add(`view-${savedView}`);

        // Attiva il bottone corretto
        viewButtons.forEach(btn => {
            if (btn.getAttribute('data-view') === savedView) {
                btn.classList.add('active');
            }
        });

        // Gestione click sui bottoni
        viewButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const view = btn.getAttribute('data-view');

                // Aggiorna UI bottoni
                viewButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Rimuovi vecchie classi vista
                body.classList.remove('view-compact', 'view-details', 'view-cards');

                // Aggiungi nuova classe
                body.classList.add(`view-${view}`);

                // Salva preferenza
                localStorage.setItem('emailViewMode', view);

                console.log(`View mode changed to: ${view}`);
            });
        });

        console.log(`View mode initialized: ${savedView}`);
    })();

    async function assignToLevel1(email, button) {
        if (!email) return;

        const originalText = button.innerHTML;
        button.disabled = true;
        button.classList.add('loading');
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

        const description = `Mittente: ${email.from}\n\nSnippet: ${email.snippet}\n\nCorpo:\n${email.body || email.snippet}`;

        try {
            const response = await fetch('/api/redmine/create-ticket', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    emailId: email.id,
                    projectId: 7291, // Maestrale Cloud
                    subject: email.subject,
                    description: description,
                    priorityId: 2, // Normale
                    assignedToId: 1021 // SysAdmin Livello 1
                })
            });

            if (response.ok) {
                const result = await response.json();
                button.innerHTML = '<i class="fa-solid fa-check"></i> OK';
                button.classList.remove('btn-outline-primary');
                button.classList.add('btn-success');
                setTimeout(() => {
                    // Ricarica le email in background per aggiornare lo stato del ticket
                    if (typeof fetchAndDisplayEmails === 'function') {
                        fetchAndDisplayEmails(true);
                    }
                }, 1500);
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Errore creazione ticket');
            }
        } catch (err) {
            console.error('Error assigning to L1:', err);
            button.innerHTML = '<i class="fa-solid fa-xmark"></i> Err';
            button.classList.add('btn-danger');
            setTimeout(() => {
                button.disabled = false;
                button.classList.remove('loading', 'btn-danger');
                button.innerHTML = originalText;
            }, 3000);
        }
    }
});

