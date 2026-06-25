document.addEventListener('DOMContentLoaded', () => {
    console.log('--- DOMContentLoaded START ---');

    let allEmails = [];
    let readEmails = [];
    let pinnedEmails = [];
    let readEmailIds = new Set(); // Track recently read email IDs to filter out eventual consistency delays
    let refreshTimer = null;
    let accountEmail = ''; // Global variable to store active Gmail account
    let currentUsername = ''; // Global variable to store active logged-in username
    let isRichTextEditorInitialized = false; // Flag to avoid double editor initialization
    let labelMap = {};
    let currentSortMode = 'date'; // 'date' o 'score'
    let currentSortDirection = 'desc'; // 'desc' o 'asc'
    let cloudMonitorIssues = [];
    let activeSpaceId = null;
    let pendingSelectSpaceId = null;
    let chatRefreshTimer = null;
    let myChatId = null; // Store the user's Google Chat ID (e.g., users/123...)
    let geminiAutoEvalTimer = null; // Timer for automatic importance evaluation
    let unreadChatCount = 0; // Counter for unread chat messages
    let chatBackgroundPollTimer = null; // Timer for background polling of all chat spaces
    let allChatSpaces = []; // Stores all known chat spaces for background polling
    let contactsList = [];
    let scoreRules = [];

    // --- Toast Notification Helper ---
    function showToast(message, type = 'success') {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-notification-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast-notification ${type}`;
        
        let iconHtml = '<i class="fa-solid fa-circle-check toast-icon"></i>';
        if (type === 'error') {
            iconHtml = '<i class="fa-solid fa-circle-xmark toast-icon"></i>';
        } else if (type === 'info') {
            iconHtml = '<i class="fa-solid fa-circle-info toast-icon"></i>';
        }

        toast.innerHTML = `
            ${iconHtml}
            <span class="toast-message">${message}</span>
        `;

        container.appendChild(toast);

        // Force reflow
        toast.offsetHeight;

        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
            toast.addEventListener('transitionend', () => {
                toast.remove();
                if (container.children.length === 0) {
                    container.remove();
                }
            });
        }, 3000);
    }

    // --- HTML Entities Decode Utility Function ---
    function decodeHTMLEntities(text) {
        if (!text) return '';
        try {
            const doc = new DOMParser().parseFromString(text, 'text/html');
            return doc.body ? doc.body.textContent : text;
        } catch (e) {
            console.error('Error decoding HTML entities:', e);
            return text;
        }
    }

    // --- CID Image Resolution Utility Functions ---
    function extractInlineAttachments(payload) {
        const inlineAttachments = [];
        if (!payload) return inlineAttachments;

        const partsToProcess = [payload];
        while (partsToProcess.length) {
            const part = partsToProcess.shift();
            if (part.parts) {
                partsToProcess.push(...part.parts);
            }

            if (part.mimeType && part.mimeType.startsWith('image/')) {
                const cidHeader = part.headers && part.headers.find(h => h.name.toLowerCase() === 'content-id');
                const xAttIdHeader = part.headers && part.headers.find(h => h.name.toLowerCase() === 'x-attachment-id');
                let contentId = '';
                if (cidHeader) {
                    contentId = cidHeader.value.replace(/[<>]/g, '');
                } else if (xAttIdHeader) {
                    contentId = xAttIdHeader.value;
                }

                if (contentId && part.body && part.body.data) {
                    inlineAttachments.push({
                        contentId: contentId,
                        mimeType: part.mimeType,
                        data: part.body.data
                    });
                }
            }
        }
        return inlineAttachments;
    }

    function replaceCidsWithBase64(html, emailOrPayload) {
        if (!html) return '';
        
        let emailId = null;
        let payload = null;
        
        if (emailOrPayload) {
            if (emailOrPayload.id) {
                emailId = emailOrPayload.id;
                payload = emailOrPayload.payload;
            } else {
                payload = emailOrPayload;
            }
        }
        
        // Se abbiamo l'ID dell'email, usiamo il nostro endpoint server sicuro e performante
        if (emailId) {
            let processedHtml = html;
            // Sostituisce src="cid:XYZ" o src='cid:XYZ'
            processedHtml = processedHtml.replace(/src=(['"]?)cid:([^'"\s>]+)\1/gi, `src=$1/api/emails/${emailId}/attachments/$2$1`);
            // Sostituisce background="cid:XYZ"
            processedHtml = processedHtml.replace(/background=(['"]?)cid:([^'"\s>]+)\1/gi, `background=$1/api/emails/${emailId}/attachments/$2$1`);
            // Sostituisce url('cid:XYZ') o url("cid:XYZ") o url(cid:XYZ) negli stili
            processedHtml = processedHtml.replace(/url\((['"]?)cid:([^'"\)]+)\1\)/gi, `url($1/api/emails/${emailId}/attachments/$2$1)`);
            return processedHtml;
        }
        
        // Fallback al meccanismo base64 se non è disponibile l'ID email
        const inlineAttachments = extractInlineAttachments(payload);
        if (inlineAttachments.length === 0) {
            return html;
        }

        let processedHtml = html;
        inlineAttachments.forEach(att => {
            if (!att.contentId || !att.data) return;

            // Pulisce l'encoding URL-safe del Base64 di Gmail (sostituendo '-' con '+' e '_' con '/')
            const cleanedBase64 = att.data.replace(/-/g, '+').replace(/_/g, '/');
            const mimeType = att.mimeType || 'image/png';
            const dataUri = `data:${mimeType};base64,${cleanedBase64}`;

            // Sostituisce src="cid:contentId" o src='cid:contentId' nell'HTML dell'email
            const escapedCid = att.contentId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const srcRegex = new RegExp(`src=(['"]?)cid:${escapedCid}\\1`, 'gi');
            processedHtml = processedHtml.replace(srcRegex, `src="${dataUri}"`);

            // Sostituisce anche eventuali riferimenti sciolti (es. cid:contentId senza src o in style/background)
            const genericRegex = new RegExp(`cid:${escapedCid}`, 'gi');
            processedHtml = processedHtml.replace(genericRegex, dataUri);
        });

        return processedHtml;
    }

    // Per-Chat Floating Bubbles Refinement
    const activeBubbles = {}; // Maps spaceId -> bubble DOM element
    const unreadCountsBySpace = {}; // Maps spaceId -> unread count integer
    let pinnedSpaces = []; // Array of { id: spaceId, name: displayName }

    // Load pinned spaces from localStorage immediately
    const savedPinned = localStorage.getItem('pinned_chat_spaces');
    if (savedPinned) {
        try {
            pinnedSpaces = JSON.parse(savedPinned);
        } catch (e) {
            pinnedSpaces = [];
        }
    }

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
        cleanupTumbleweed();
        const humanView = document.getElementById('human-view');
        const botView = document.getElementById('bot-view');
        const cloudMonitorView = document.getElementById('cloud-monitor-view');
        const readEmailsView = document.getElementById('read-emails-view');
        const backupView = document.getElementById('backup-view');
        const redmineView = document.getElementById('redmine-view');
        const pinnedView = document.getElementById('pinned-view');
        const activityView = document.getElementById('activity-view');
        const statsView = document.getElementById('stats-view');
        const chatView = document.getElementById('chat-view');
        const humanTab = document.getElementById('human-tab');
        const botTab = document.getElementById('bot-tab');
        const cloudMonitorTab = document.getElementById('cloud-monitor-tab');
        const readEmailsTab = document.getElementById('read-emails-tab');
        const backupTab = document.getElementById('backup-tab');
        const redmineTab = document.getElementById('redmine-dashboard-btn');
        const pinnedTab = document.getElementById('show-pinned-emails');
        const activityTab = document.getElementById('activity-tab');
        const statsTab = document.getElementById('stats-tab');
        const chatTab = document.getElementById('chat-tab');

        if (humanView) humanView.style.display = tabName === 'human' ? 'block' : 'none';
        if (botView) botView.style.display = tabName === 'bot' ? 'block' : 'none';
        if (cloudMonitorView) cloudMonitorView.style.display = tabName === 'cloud-monitor' ? 'block' : 'none';
        if (readEmailsView) readEmailsView.style.display = tabName === 'read-emails' ? 'block' : 'none';
        if (backupView) backupView.style.display = tabName === 'backup' ? 'block' : 'none';
        if (redmineView) redmineView.style.display = tabName === 'redmine' ? 'block' : 'none';
        if (pinnedView) pinnedView.style.display = tabName === 'pinned' ? 'block' : 'none';
        if (activityView) activityView.style.display = tabName === 'activity' ? 'block' : 'none';
        if (statsView) statsView.style.display = tabName === 'stats' ? 'block' : 'none';

        if (humanTab) humanTab.classList.toggle('active', tabName === 'human');
        if (botTab) botTab.classList.toggle('active', tabName === 'bot');
        if (cloudMonitorTab) cloudMonitorTab.classList.toggle('active', tabName === 'cloud-monitor');
        if (readEmailsTab) readEmailsTab.classList.toggle('active', tabName === 'read-emails');
        if (backupTab) backupTab.classList.toggle('active', tabName === 'backup');
        if (pinnedTab) pinnedTab.classList.toggle('active', tabName === 'pinned');
        if (activityTab) activityTab.classList.toggle('active', tabName === 'activity');
        if (statsTab) statsTab.classList.toggle('active', tabName === 'stats');

        // Manage header button active states specifically for custom dashboards
        if (redmineTab) {
            redmineTab.classList.toggle('active', tabName === 'redmine');
            redmineTab.classList.toggle('btn-warning', tabName === 'redmine');
            redmineTab.classList.toggle('btn-outline-warning', tabName !== 'redmine');
        }

        // Manage central read-emails-btn dynamically based on active tab
        const readEmailsBtn = document.getElementById('read-emails-btn');
        if (readEmailsBtn) {
            if (tabName === 'read-emails') {
                readEmailsBtn.innerHTML = '<i class="fa-solid fa-envelope"></i> <span class="btn-text">Segna da Leggere</span>';
                readEmailsBtn.title = 'Segna come da leggere';
                readEmailsBtn.className = 'btn btn-outline-warning';
            } else {
                readEmailsBtn.innerHTML = '<i class="fa-solid fa-envelope-open-text"></i> <span class="btn-text">Segna Lette</span>';
                readEmailsBtn.title = 'Segna come lette';
                readEmailsBtn.className = 'btn btn-outline-primary';
            }
        }

        // Manage sticky-notes-container visibility (hidden ONLY on Backup Hub, Redmine Dashboard, and Stats Dashboard)
        const stickyNotesContainer = document.getElementById('sticky-notes-container');
        if (stickyNotesContainer) {
            if (tabName === 'backup' || tabName === 'redmine' || tabName === 'stats') {
                stickyNotesContainer.style.setProperty('display', 'none', 'important');
            } else {
                stickyNotesContainer.style.removeProperty('display');
                const hasNotes = stickyNotesContainer.querySelectorAll('.sticky-note').length > 0;
                stickyNotesContainer.style.display = hasNotes ? 'flex' : 'none';
            }
        }

        const categoryFilterContainer = document.querySelector('.category-filter-container');
        const categoryFilterWrapper = document.getElementById('category-filter-wrapper');
        const cloudHoursFilterWrapper = document.getElementById('cloud-hours-filter-wrapper');
        
        if (categoryFilterContainer) {
            categoryFilterContainer.style.display = (tabName === 'backup' || tabName === 'activity' || tabName === 'redmine' || tabName === 'stats') ? 'none' : 'flex';
        }
        if (categoryFilterWrapper) {
            categoryFilterWrapper.style.display = (tabName === 'human' || tabName === 'bot' || tabName === 'read-emails') ? 'flex' : 'none';
        }
        if (cloudHoursFilterWrapper) {
            cloudHoursFilterWrapper.style.display = (tabName === 'cloud-monitor') ? 'flex' : 'none';
        }

        const selectFilteredCheckbox = document.getElementById('select-filtered-checkbox');
        const selectAllCheckbox = document.getElementById('select-all-checkbox');
        const selectUselessCheckbox = document.getElementById('select-useless-checkbox');
        if (selectFilteredCheckbox) selectFilteredCheckbox.checked = false;
        if (selectAllCheckbox) selectAllCheckbox.checked = false;
        if (selectUselessCheckbox) selectUselessCheckbox.checked = false;

        if (tabName === 'activity') {
            fetchAndDisplayActivities(1);
        } else if (tabName === 'redmine') {
            loadRedmineDashboard();
        } else if (tabName === 'read-emails') {
            fetchAndDisplayReadEmails(false, true);
        } else if (tabName === 'stats') {
            loadEmailStats();
        }

        // Check if the tab we just switched to has the empty message, and trigger the tumbleweed if so
        let containerToCheck = null;
        if (tabName === 'human') {
            containerToCheck = humanEmailListContainer;
        } else if (tabName === 'bot') {
            containerToCheck = botEmailListContainer;
        } else if (tabName === 'read-emails') {
            containerToCheck = document.getElementById('read-emails-list-container');
        }
        
        if (containerToCheck && containerToCheck.innerHTML.includes('No unread emails found in this category.')) {
            triggerTumbleweed();
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
            if (document.getElementById('stats-view') && document.getElementById('stats-view').style.display !== 'none') {
                loadEmailStats();
            }
        });
    }


    const selectAllCheckbox = document.getElementById('select-all-checkbox');
    const selectFilteredCheckbox = document.getElementById('select-filtered-checkbox');
    const importanceMinSelect = document.getElementById('importance-min-select');
    const importanceMaxSelect = document.getElementById('importance-max-select');
    const humanEmailListContainer = document.getElementById('human-email-list-container');
    const botEmailListContainer = document.getElementById('bot-email-list-container');
    const humanHighlightedEmailsContainer = document.getElementById('human-highlighted-emails-container');
    const botHighlightedEmailsContainer = document.getElementById('bot-highlighted-emails-container');
    const humanView = document.getElementById('human-view');
    const botView = document.getElementById('bot-view');
    const sortSelect = document.getElementById('sort-select');
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
    const readEmailsTab = document.getElementById('read-emails-tab');
    const backupTab = document.getElementById('backup-tab');

    let lastActiveTab = 'human';
    if (humanTab) humanTab.addEventListener('click', () => { lastActiveTab = 'human'; showTab('human'); });
    if (botTab) botTab.addEventListener('click', () => { lastActiveTab = 'bot'; showTab('bot'); });
    if (cloudMonitorTab) cloudMonitorTab.addEventListener('click', () => { lastActiveTab = 'cloud-monitor'; showTab('cloud-monitor'); });
    if (readEmailsTab) readEmailsTab.addEventListener('click', () => { lastActiveTab = 'read-emails'; showTab('read-emails'); });
    if (backupTab) backupTab.addEventListener('click', () => { lastActiveTab = 'backup'; showTab('backup'); });
    const activityTab = document.getElementById('activity-tab');
    if (activityTab) activityTab.addEventListener('click', () => { lastActiveTab = 'activity'; showTab('activity'); });
    const statsTab = document.getElementById('stats-tab');
    if (statsTab) statsTab.addEventListener('click', () => showTab('stats'));
    const refreshStatsBtn = document.getElementById('refresh-stats-btn');
    if (refreshStatsBtn) refreshStatsBtn.addEventListener('click', () => loadEmailStats(true));
    const statsPeriodSelect = document.getElementById('stats-period-select');
    if (statsPeriodSelect) {
        statsPeriodSelect.addEventListener('change', () => loadEmailStats(true));
    }

    const statsTabToggle = document.getElementById('stats-tab-toggle');
    const statsTabWrapper = document.getElementById('stats-tab-wrapper');
    
    if (localStorage.getItem('statsTabCollapsed') === 'true') {
        if (statsTabWrapper) statsTabWrapper.classList.add('collapsed');
        if (statsTabToggle) {
            statsTabToggle.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
            statsTabToggle.title = "Mostra Analisi Nerd";
        }
    }

    if (statsTabToggle && statsTabWrapper) {
        statsTabToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const willCollapse = !statsTabWrapper.classList.contains('collapsed');
            if (willCollapse) {
                statsTabWrapper.classList.add('collapsed');
                statsTabToggle.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
                statsTabToggle.title = "Mostra Analisi Nerd";
                localStorage.setItem('statsTabCollapsed', 'true');
                if (statsTab && statsTab.classList.contains('active')) {
                    showTab(lastActiveTab);
                }
            } else {
                statsTabWrapper.classList.remove('collapsed');
                statsTabToggle.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
                statsTabToggle.title = "Nascondi Analisi Nerd";
                localStorage.setItem('statsTabCollapsed', 'false');
            }
        });
    }

    // Drag & Drop tab drop targets
    [humanTab, botTab].forEach(tab => {
        if (!tab) return;
        tab.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            tab.classList.add('drag-over');
        });

        tab.addEventListener('dragenter', (e) => {
            e.preventDefault();
            tab.classList.add('drag-over');
        });

        tab.addEventListener('dragleave', () => {
            tab.classList.remove('drag-over');
        });

        tab.addEventListener('drop', async (e) => {
            e.preventDefault();
            tab.classList.remove('drag-over');
            const emailId = e.dataTransfer.getData('text/plain');
            if (!emailId) return;

            const targetCategory = tab.id === 'human-tab' ? 'Human' : 'Bot';
            console.log(`Dropped email ${emailId} onto ${targetCategory}`);
            
            const email = allEmails.find(e => e.id === emailId);
            if (email && email.category !== targetCategory) {
                await reclassifyEmail(emailId, targetCategory);
            }
        });
    });

    // Auto-scroll page during drag operations
    let dragScrollInterval = null;
    let dragScrollSpeed = 0;
    let isBoosting = false;
    let boostInterval = null;

    function startDragScroll(speed) {
        if (isBoosting) return; // Ignore normal scrolling if we are actively boosting
        dragScrollSpeed = speed;
        if (!dragScrollInterval) {
            dragScrollInterval = setInterval(() => {
                if (dragScrollSpeed !== 0 && !isBoosting) {
                    window.scrollBy(0, dragScrollSpeed);
                } else {
                    stopDragScroll();
                }
            }, 16); // ~60fps scroll loop
        }
    }

    function stopDragScroll() {
        dragScrollSpeed = 0;
        if (dragScrollInterval) {
            clearInterval(dragScrollInterval);
            dragScrollInterval = null;
        }
    }

function triggerSuperBoost() {
    // Stop any previous scrolling/boost intervals
    stopDragScroll();
    if (boostInterval) { clearInterval(boostInterval); boostInterval = null; }

    const boostPad = document.querySelector('.drag-boost-pad');
    if (boostPad) { boostPad.classList.add('activated'); }

    // Instantly scroll to the top with smooth behavior
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Remove visual activation after a short delay
    setTimeout(() => {
        if (boostPad) { boostPad.classList.remove('activated'); }
    }, 500);
}

    function showBoostPad() {
        let boostPad = document.querySelector('.drag-boost-pad');
        if (!boostPad) {
            boostPad = document.createElement('div');
            boostPad.className = 'drag-boost-pad';
            boostPad.innerHTML = `
                <div class="boost-content">
                    <i class="fa-solid fa-angles-up boost-arrow animate-boost"></i>
                    <span>SUPER BOOST ⚡</span>
                    <i class="fa-solid fa-angles-up boost-arrow animate-boost"></i>
                </div>
            `;

            // Trigger boost when a dragged element is over/enters the pad
            boostPad.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                boostPad.classList.add('drag-over');
                triggerSuperBoost();
            });

            boostPad.addEventListener('dragenter', (e) => {
                e.preventDefault();
                boostPad.classList.add('drag-over');
                triggerSuperBoost();
            });

            boostPad.addEventListener('dragleave', () => {
                boostPad.classList.remove('drag-over');
            });

            document.body.appendChild(boostPad);
        }

        // Trigger slide-down and fade-in animation
        setTimeout(() => {
            boostPad.classList.add('visible');
        }, 10);
    }

    function hideBoostPad() {
        const boostPad = document.querySelector('.drag-boost-pad');
        if (boostPad) {
            boostPad.classList.remove('visible');
            boostPad.classList.remove('drag-over');
            setTimeout(() => {
                if (!boostPad.classList.contains('visible') && boostPad.parentNode) {
                    boostPad.remove();
                }
            }, 300);
        }
        isBoosting = false;
        if (boostInterval) {
            clearInterval(boostInterval);
            boostInterval = null;
        }
    }

    document.addEventListener('dragover', (e) => {
        // Only scroll if there is an active email item being dragged
        if (!document.querySelector('.email-item.dragging')) {
            stopDragScroll();
            return;
        }

        // Check if mouse cursor is over the boost pad
        const boostPad = document.querySelector('.drag-boost-pad');
        if (boostPad && boostPad.classList.contains('visible')) {
            const rect = boostPad.getBoundingClientRect();
            const x = e.clientX;
            const y = e.clientY;
            const padding = 15; // extra hit tolerance pixels

            if (
                x >= rect.left - padding &&
                x <= rect.right + padding &&
                y >= rect.top - padding &&
                y <= rect.bottom + padding
            ) {
                boostPad.classList.add('drag-over');
                triggerSuperBoost();
                return;
            }
        }

        // If we are actively boosting, ignore normal dragover scrolling
        if (isBoosting) {
            stopDragScroll();
            return;
        }

        const threshold = 150; // distance in px from the top/bottom viewport boundaries
        const maxSpeed = 30; // maximum pixels to scroll per frame
        const viewportHeight = window.innerHeight;
        const y = e.clientY;

        if (y < threshold) {
            // Near top: scroll up
            const ratio = (threshold - y) / threshold;
            const speed = -Math.max(4, ratio * maxSpeed);
            startDragScroll(speed);
        } else if (y > viewportHeight - threshold) {
            // Near bottom: scroll down
            const ratio = (y - (viewportHeight - threshold)) / threshold;
            const speed = Math.max(4, ratio * maxSpeed);
            startDragScroll(speed);
        } else {
            stopDragScroll();
        }
    });

    document.addEventListener('dragend', () => {
        stopDragScroll();
        hideBoostPad();
    });

    document.addEventListener('drop', () => {
        stopDragScroll();
        hideBoostPad();
    });

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

    // Request browser push notification permission
    function requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(permission => {
                console.log('[Chat] Notification permission:', permission);
            });
        }
    }

    // Show browser push notification
    function showBrowserPushNotification(senderName, messageText, spaceId) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        // Don't show if tab is focused and chat panel is open
        if (document.hasFocus() && chatPanel && chatPanel.style.display === 'flex' && activeSpaceId === spaceId) return;

        const notif = new Notification(`💬 ${senderName}`, {
            body: messageText,
            icon: '/favicon-96x96.png',
            badge: '/favicon-96x96.png',
            tag: `chat-${spaceId}`,
            renotify: true,
            silent: false
        });

        notif.onclick = () => {
            window.focus();
            if (chatPanel) {
                chatPanel.style.display = 'flex';
                if (spaceId) {
                    pendingSelectSpaceId = spaceId;
                    unreadCountsBySpace[spaceId] = 0;
                    if (typeof syncSidebarSpaceBadge === 'function') syncSidebarSpaceBadge(spaceId);
                    if (typeof syncBubbleBadge === 'function') syncBubbleBadge(spaceId);
                }
                unreadChatCount = Object.values(unreadCountsBySpace).reduce((a, b) => a + b, 0);
                updateChatBadge(false);
                
                if (!hasFetchedChatSpaces) {
                    hasFetchedChatSpaces = true;
                    fetchChatSpaces();
                } else if (spaceId) {
                    const space = allChatSpaces.find(s => s.name.endsWith('/' + spaceId));
                    if (space) {
                        selectChatSpace(spaceId, space.displayName || 'Direct Message');
                    }
                }
            }
            notif.close();
        };
    }

    // Update badge with count
    function updateChatBadge(increment = true, spaceId = null) {
        if (increment && spaceId) {
            unreadCountsBySpace[spaceId] = (unreadCountsBySpace[spaceId] || 0) + 1;
            unreadChatCount = Object.values(unreadCountsBySpace).reduce((a, b) => a + b, 0);
        }
        if (chatBadge) {
            if (unreadChatCount > 0) {
                chatBadge.textContent = unreadChatCount > 99 ? '99+' : unreadChatCount;
                chatBadge.style.display = 'inline-flex';
                chatBadge.classList.remove('badge-pulse');
                // Force reflow to restart animation
                void chatBadge.offsetWidth;
                chatBadge.classList.add('badge-pulse');
            } else {
                chatBadge.style.display = 'none';
                chatBadge.classList.remove('badge-pulse');
            }
        }
        // Sync badge on specific floating chat head bubble if active
        if (spaceId && typeof syncBubbleBadge === 'function') {
            syncBubbleBadge(spaceId);
        }
        if (spaceId && typeof syncSidebarSpaceBadge === 'function') {
            syncSidebarSpaceBadge(spaceId);
        }
    }

    // Reset badge count
    function resetChatBadge() {
        unreadChatCount = 0;
        Object.keys(unreadCountsBySpace).forEach(sid => {
            unreadCountsBySpace[sid] = 0;
            if (typeof syncBubbleBadge === 'function') {
                syncBubbleBadge(sid);
            }
            if (typeof syncSidebarSpaceBadge === 'function') {
                syncSidebarSpaceBadge(sid);
            }
        });
        if (chatBadge) {
            chatBadge.style.display = 'none';
            chatBadge.classList.remove('badge-pulse');
        }
    }

    // Background polling: fetch all known spaces silently to detect new messages
    async function pollAllChatSpacesInBackground(seedOnly = false) {
        if (allChatSpaces.length === 0) return;
        for (const space of allChatSpaces) {
            const spaceId = space.name ? space.name.split('/')[1] : null;
            if (!spaceId) continue;
            try {
                const response = await fetch(`/api/chat/messages/${spaceId}`);
                if (!response.ok) continue;
                const data = await response.json();
                // Process only silently (for notification/badge only, no UI render unless active space)
                if (data.messages) {
                    if (seedOnly) {
                        // Just register message IDs without notifications
                        data.messages.forEach(msg => seenChatMessageIds.add(msg.name));
                    } else {
                        processNewMessagesForNotifications(data.messages, data.membersMap || {}, spaceId);
                    }
                }
            } catch (e) {
                // Silently fail
            }
        }
    }

    // Process messages array looking for unseen ones (used by background poll)
    function processNewMessagesForNotifications(messages, membersMap, spaceId) {
        let hasNew = false;
        messages.forEach(msg => {
            if (!seenChatMessageIds.has(msg.name)) {
                seenChatMessageIds.add(msg.name);
                const senderUserId = msg.sender?.name || '';
                const isMine = (senderUserId === myChatId) || (msg.sender && msg.sender.email === accountEmail);
                if (!isMine) {
                    hasNew = true;
                    
                    const isChatOpen = chatPanel && chatPanel.style.display === 'flex';
                    const isActiveSpace = activeSpaceId === spaceId;
                    
                    if (!isChatOpen || !isActiveSpace) {
                        // Increment specific space unread count
                        unreadCountsBySpace[spaceId] = (unreadCountsBySpace[spaceId] || 0) + 1;
                        
                        const senderName = msg.sender?.displayName || membersMap[senderUserId] || 'Nuovo messaggio';
                        let notifText = msg.text || '';
                        if (!notifText && msg.attachment && msg.attachment.length > 0) {
                            notifText = msg.attachment[0].contentType?.startsWith('image/') ? '(Immagine)' : '(Allegato)';
                        }
                        showChatNotification(senderName, notifText, spaceId);
                        showBrowserPushNotification(senderName, notifText, spaceId);
                    }
                }
            }
        });

        // Update badge if chat panel is closed or different space is active
        if (hasNew) {
            const isChatOpen = chatPanel && chatPanel.style.display === 'flex';
            const isActiveSpace = activeSpaceId === spaceId;
            if (!isChatOpen || !isActiveSpace) {
                unreadChatCount = Object.values(unreadCountsBySpace).reduce((a, b) => a + b, 0);
                updateChatBadge(false, spaceId); // update UI using current values without double incrementing
            }
        }
    }

    if (toggleChatBtn && chatPanel) {
        toggleChatBtn.addEventListener('click', () => {
            if (chatPanel.style.display === 'none' || chatPanel.style.display === '') {
                chatPanel.style.display = 'flex';
                
                // Clear unread count for active space only, if any
                if (activeSpaceId) {
                    unreadCountsBySpace[activeSpaceId] = 0;
                    if (typeof syncSidebarSpaceBadge === 'function') syncSidebarSpaceBadge(activeSpaceId);
                    if (typeof syncBubbleBadge === 'function') syncBubbleBadge(activeSpaceId);
                }
                
                unreadChatCount = Object.values(unreadCountsBySpace).reduce((a, b) => a + b, 0);
                updateChatBadge(false);
                
                if (!hasFetchedChatSpaces) {
                    hasFetchedChatSpaces = true;
                    fetchChatSpaces();
                }
            } else {
                chatPanel.style.display = 'none';
            }
        });
    }

    // Request notification permission on load
    requestNotificationPermission();

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

    // --- 8-Directional Windows-Style Chat Panel Resizer ---
    if (chatPanel) {
        const directions = ['t', 'r', 'b', 'l', 'tl', 'tr', 'bl', 'br'];
        const resizerHandles = {};

        directions.forEach(dir => {
            const handle = document.createElement('div');
            handle.className = `chat-panel-resizer resizer-${dir}`;
            chatPanel.appendChild(handle);
            resizerHandles[dir] = handle;
        });

        let isResizingChat = false;
        let activeResizer = '';
        let startWidth = 0;
        let startHeight = 0;
        let startLeft = 0;
        let startTop = 0;
        let startX = 0;
        let startY = 0;

        const minWidth = 300;
        const minHeight = 400;

        // Shared start resize logic
        function startResize(e, dir, clientX, clientY) {
            isResizingChat = true;
            activeResizer = dir;
            startX = clientX;
            startY = clientY;

            const rect = chatPanel.getBoundingClientRect();
            startWidth = rect.width;
            startHeight = rect.height;
            startLeft = rect.left;
            startTop = rect.top;

            document.body.style.userSelect = 'none'; // Prevent text selection
        }

        // Add event listeners for all handles (Mouse & Touch)
        directions.forEach(dir => {
            const handle = resizerHandles[dir];
            
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                startResize(e, dir, e.clientX, e.clientY);
            });

            handle.addEventListener('touchstart', (e) => {
                e.stopPropagation();
                const touch = e.touches[0];
                startResize(e, dir, touch.clientX, touch.clientY);
            }, { passive: true });
        });

        // Mouse Resize Move
        document.addEventListener('mousemove', (e) => {
            if (!isResizingChat) return;
            performResize(e.clientX, e.clientY);
        });

        // Touch Resize Move
        document.addEventListener('touchmove', (e) => {
            if (!isResizingChat) return;
            const touch = e.touches[0];
            performResize(touch.clientX, touch.clientY);
        }, { passive: true });

        // Resize End
        function stopResize() {
            if (isResizingChat) {
                isResizingChat = false;
                document.body.style.userSelect = '';
                // Persist sizes
                localStorage.setItem('chat_panel_width', chatPanel.style.width);
                localStorage.setItem('chat_panel_height', chatPanel.style.height);
            }
        }

        document.addEventListener('mouseup', stopResize);
        document.addEventListener('touchend', stopResize);

        // Core Resize Math Engine
        function performResize(clientX, clientY) {
            const dx = clientX - startX;
            const dy = clientY - startY;

            let newWidth = startWidth;
            let newHeight = startHeight;
            let newLeft = startLeft;
            let newTop = startTop;

            // X-Axis Resizing (Width and Left)
            if (activeResizer.includes('r')) {
                newWidth = startWidth + dx;
                if (newWidth < minWidth) {
                    newWidth = minWidth;
                }
            } else if (activeResizer.includes('l')) {
                newWidth = startWidth - dx;
                if (newWidth < minWidth) {
                    newWidth = minWidth;
                    newLeft = startLeft + (startWidth - minWidth);
                } else {
                    newLeft = startLeft + dx;
                }
                // Screen boundaries edge clamping
                if (newLeft < 0) {
                    newWidth += newLeft;
                    newLeft = 0;
                }
            }

            // Y-Axis Resizing (Height and Top)
            if (activeResizer.includes('b')) {
                newHeight = startHeight + dy;
                if (newHeight < minHeight) {
                    newHeight = minHeight;
                }
            } else if (activeResizer.includes('t')) {
                newHeight = startHeight - dy;
                if (newHeight < minHeight) {
                    newHeight = minHeight;
                    newTop = startTop + (startHeight - minHeight);
                } else {
                    newTop = startTop + dy;
                }
                // Screen boundaries edge clamping
                if (newTop < 0) {
                    newHeight += newTop;
                    newTop = 0;
                }
            }

            // Apply calculated size & position
            if (newWidth >= minWidth) {
                chatPanel.style.width = `${newWidth}px`;
                if (activeResizer.includes('l')) {
                    chatPanel.style.left = `${newLeft}px`;
                    chatPanel.style.right = 'auto'; // Disable right anchor
                }
            }
            if (newHeight >= minHeight) {
                chatPanel.style.height = `${newHeight}px`;
                if (activeResizer.includes('t')) {
                    chatPanel.style.top = `${newTop}px`;
                }
            }
        }

        // Restore saved custom dimensions on startup
        const savedPanelWidth = localStorage.getItem('chat_panel_width');
        const savedPanelHeight = localStorage.getItem('chat_panel_height');
        if (savedPanelWidth) chatPanel.style.width = savedPanelWidth;
        if (savedPanelHeight) chatPanel.style.height = savedPanelHeight;
    }


    // --- Draggable Chat Sidebar Resizer ---
    const chatSidebar = document.getElementById('chat-sidebar');
    const chatSidebarResizer = document.getElementById('chat-sidebar-resizer');

    if (chatSidebar && chatSidebarResizer) {
        let isResizingSidebar = false;

        chatSidebarResizer.addEventListener('mousedown', (e) => {
            isResizingSidebar = true;
            chatSidebarResizer.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizingSidebar) return;

            const containerRect = chatSidebar.parentElement.getBoundingClientRect();
            let newWidth = e.clientX - containerRect.left;

            // Sidebar min/max constraints
            const minWidth = 80;
            const maxWidth = containerRect.width * 0.7; // Max 70% of panel width
            if (newWidth < minWidth) newWidth = minWidth;
            if (newWidth > maxWidth) newWidth = maxWidth;

            chatSidebar.style.width = `${newWidth}px`;
            localStorage.setItem('chat_sidebar_width', `${newWidth}px`);
        });

        document.addEventListener('mouseup', () => {
            if (isResizingSidebar) {
                isResizingSidebar = false;
                chatSidebarResizer.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });

        // Restore saved width on startup
        const savedWidth = localStorage.getItem('chat_sidebar_width');
        if (savedWidth) {
            chatSidebar.style.width = savedWidth;
        }
    }

    // --- Chat Head Bubbles & Transparency Logic ---
    const toggleChatBubbleBtn = document.getElementById('toggle-chat-bubble-btn');
    const minimizeToBubbleBtn = document.getElementById('minimize-to-bubble-btn');
    const toggleChatTransparencyBtn = document.getElementById('toggle-chat-transparency-btn');
    const pinChatBubbleBtn = document.getElementById('pin-chat-bubble-btn');
    
    let isChatTransparent = false;
    let areBubblesHidden = false;

    // Load transparency preference on load
    const savedTransparency = localStorage.getItem('chat_transparency');
    if (savedTransparency === 'true') {
        isChatTransparent = true;
        if (chatPanel) chatPanel.classList.add('semi-transparent');
        updateTransparencyIcon();
    }

    function updateTransparencyIcon() {
        if (!toggleChatTransparencyBtn) return;
        const icon = toggleChatTransparencyBtn.querySelector('i');
        if (icon) {
            if (isChatTransparent) {
                icon.className = 'fa-solid fa-eye-slash';
                toggleChatTransparencyBtn.title = 'Rendi opaco';
            } else {
                icon.className = 'fa-solid fa-eye';
                toggleChatTransparencyBtn.title = 'Fissa semi-trasparente';
            }
        }
    }

    if (toggleChatTransparencyBtn) {
        toggleChatTransparencyBtn.addEventListener('click', () => {
            isChatTransparent = !isChatTransparent;
            if (isChatTransparent) {
                chatPanel.classList.add('semi-transparent');
            } else {
                chatPanel.classList.remove('semi-transparent');
            }
            localStorage.setItem('chat_transparency', isChatTransparent ? 'true' : 'false');
            updateTransparencyIcon();
        });
    }

    // Helper: extract initials from display name
    function getInitials(name) {
        if (!name) return '?';
        const cleanName = name.replace(/[^\w\s\d]/g, '').trim();
        if (!cleanName) return name.slice(0, 2).toUpperCase();
        const parts = cleanName.split(/\s+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return cleanName.slice(0, 2).toUpperCase();
    }

    // Modularized Space Selection Helper
    function selectChatSpace(spaceId, displayName) {
        activeSpaceId = spaceId;
        document.getElementById('active-chat-name').textContent = displayName;
        
        // Highlight in sidebar
        const items = document.querySelectorAll('.chat-space-item');
        items.forEach(el => {
            if (el.getAttribute('data-space-id') === spaceId) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });

        // Reset unread count for this space
        unreadCountsBySpace[spaceId] = 0;
        unreadChatCount = Object.values(unreadCountsBySpace).reduce((a, b) => a + b, 0);
        
        if (unreadChatCount > 0) {
            if (chatBadge) {
                chatBadge.textContent = unreadChatCount > 99 ? '99+' : unreadChatCount;
                chatBadge.style.display = 'inline-flex';
            }
        } else {
            if (chatBadge) chatBadge.style.display = 'none';
        }

        // Sync bubble badge
        syncBubbleBadge(spaceId);
        syncSidebarSpaceBadge(spaceId);

        // Fetch messages
        fetchChatMessages(spaceId);
        
        // Refresh timer for active space
        if (chatRefreshTimer) clearInterval(chatRefreshTimer);
        chatRefreshTimer = setInterval(() => fetchChatMessages(spaceId, true), 5000);

        // Update pin button state
        updatePinButtonState();
    }

    // Update Thumbtack/Pin Icon color and state
    function updatePinButtonState() {
        if (!pinChatBubbleBtn) return;
        if (activeSpaceId && pinnedSpaces.some(s => s.id === activeSpaceId)) {
            pinChatBubbleBtn.classList.add('active');
            pinChatBubbleBtn.style.color = '#ffc107'; // beautiful golden yellow when pinned
            pinChatBubbleBtn.title = 'Sblocca questa chat (rimuovi bolla)';
        } else {
            pinChatBubbleBtn.classList.remove('active');
            pinChatBubbleBtn.style.color = 'white';
            pinChatBubbleBtn.title = 'Fissa questa chat come bolla';
        }
    }

    // Pin Button click listener
    if (pinChatBubbleBtn) {
        pinChatBubbleBtn.addEventListener('click', () => {
            if (!activeSpaceId) {
                alert('Seleziona prima una chat per poterla fissare come bolla!');
                return;
            }
            const displayName = document.getElementById('active-chat-name').textContent;
            const isPinned = pinnedSpaces.some(s => s.id === activeSpaceId);
            if (isPinned) {
                destroyChatBubble(activeSpaceId);
            } else {
                pinnedSpaces.push({ id: activeSpaceId, name: displayName });
                localStorage.setItem('pinned_chat_spaces', JSON.stringify(pinnedSpaces));
                spawnChatBubble(activeSpaceId, displayName);
                updatePinButtonState();
            }
        });
    }

    // Minimize Button click listener
    if (minimizeToBubbleBtn) {
        minimizeToBubbleBtn.addEventListener('click', () => {
            if (activeSpaceId) {
                const displayName = document.getElementById('active-chat-name').textContent;
                if (!pinnedSpaces.some(s => s.id === activeSpaceId)) {
                    pinnedSpaces.push({ id: activeSpaceId, name: displayName });
                    localStorage.setItem('pinned_chat_spaces', JSON.stringify(pinnedSpaces));
                    spawnChatBubble(activeSpaceId, displayName);
                    updatePinButtonState();
                }
            }
            if (chatPanel) chatPanel.style.display = 'none';
        });
    }

    // Main header control toggles all bubbles
    if (toggleChatBubbleBtn) {
        // Toggle the active state of the button
        if (pinnedSpaces.length > 0) {
            toggleChatBubbleBtn.classList.add('active');
        }
        
        toggleChatBubbleBtn.addEventListener('click', () => {
            areBubblesHidden = !areBubblesHidden;
            Object.keys(activeBubbles).forEach(spaceId => {
                const bubble = activeBubbles[spaceId];
                if (bubble) {
                    bubble.style.display = areBubblesHidden ? 'none' : 'flex';
                }
            });
            if (areBubblesHidden) {
                toggleChatBubbleBtn.classList.remove('active');
            } else {
                toggleChatBubbleBtn.classList.add('active');
            }
        });
    }

    // Spawn a bubble for a specific chat space
    function spawnChatBubble(spaceId, displayName) {
        if (activeBubbles[spaceId]) return;

        // If bubbles were hidden, show them again
        if (areBubblesHidden) {
            areBubblesHidden = false;
            if (toggleChatBubbleBtn) toggleChatBubbleBtn.classList.add('active');
            Object.keys(activeBubbles).forEach(sid => {
                const bubble = activeBubbles[sid];
                if (bubble) bubble.style.display = 'flex';
            });
        }

        // Create elements
        const bubbleEl = document.createElement('div');
        bubbleEl.id = `chat-bubble-head-${spaceId}`;
        bubbleEl.className = 'chat-bubble-head';
        
        let bubbleX = window.innerWidth - 80;
        // Stack vertically if no coords saved yet (70px per bubble)
        let bubbleY = 150 + Object.keys(activeBubbles).length * 70;
        
        const savedX = localStorage.getItem(`chat_bubble_${spaceId}_x`);
        const savedY = localStorage.getItem(`chat_bubble_${spaceId}_y`);
        if (savedX !== null && savedY !== null) {
            bubbleX = Math.max(0, Math.min(parseInt(savedX, 10), window.innerWidth - 65));
            bubbleY = Math.max(0, Math.min(parseInt(savedY, 10), window.innerHeight - 65));
        }

        bubbleEl.style.left = `${bubbleX}px`;
        bubbleEl.style.top = `${bubbleY}px`;
        bubbleEl.style.right = 'auto';

        const initials = getInitials(displayName);
        bubbleEl.innerHTML = `
            <span class="chat-bubble-initials">${DOMPurify.sanitize(initials)}</span>
            <span id="chat-bubble-badge-${spaceId}" class="chat-bubble-badge" style="display: none;">0</span>
            <div class="chat-bubble-close" title="Rimuovi bolla">&times;</div>
        `;

        document.body.appendChild(bubbleEl);
        activeBubbles[spaceId] = bubbleEl;
        
        syncBubbleBadge(spaceId);

        let isDraggingBubble = false;
        let bubbleDragStartX = 0;
        let bubbleDragStartY = 0;
        let bubbleInitialX = 0;
        let bubbleInitialY = 0;
        let hasDraggedSignificantly = false;

        const closeBtn = bubbleEl.querySelector('.chat-bubble-close');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            destroyChatBubble(spaceId);
        });

        // Mouse Drag events
        bubbleEl.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('chat-bubble-close')) return;
            isDraggingBubble = true;
            hasDraggedSignificantly = false;
            bubbleDragStartX = e.clientX;
            bubbleDragStartY = e.clientY;
            const rect = bubbleEl.getBoundingClientRect();
            bubbleInitialX = rect.left;
            bubbleInitialY = rect.top;
            bubbleEl.style.transition = 'none';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDraggingBubble) return;
            
            const dx = e.clientX - bubbleDragStartX;
            const dy = e.clientY - bubbleDragStartY;
            
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
                hasDraggedSignificantly = true;
            }

            let newX = bubbleInitialX + dx;
            let newY = bubbleInitialY + dy;

            newX = Math.max(0, Math.min(newX, window.innerWidth - 60));
            newY = Math.max(0, Math.min(newY, window.innerHeight - 60));

            bubbleEl.style.left = `${newX}px`;
            bubbleEl.style.top = `${newY}px`;
        });

        document.addEventListener('mouseup', () => {
            if (isDraggingBubble) {
                isDraggingBubble = false;
                document.body.style.userSelect = '';
                bubbleEl.style.transition = '';
                
                const rect = bubbleEl.getBoundingClientRect();
                localStorage.setItem(`chat_bubble_${spaceId}_x`, rect.left);
                localStorage.setItem(`chat_bubble_${spaceId}_y`, rect.top);
            }
        });

        // Touch Drag events for mobile
        bubbleEl.addEventListener('touchstart', (e) => {
            if (e.target.classList.contains('chat-bubble-close')) return;
            isDraggingBubble = true;
            hasDraggedSignificantly = false;
            const touch = e.touches[0];
            bubbleDragStartX = touch.clientX;
            bubbleDragStartY = touch.clientY;
            const rect = bubbleEl.getBoundingClientRect();
            bubbleInitialX = rect.left;
            bubbleInitialY = rect.top;
            bubbleEl.style.transition = 'none';
        }, { passive: true });

        bubbleEl.addEventListener('touchmove', (e) => {
            if (!isDraggingBubble) return;
            const touch = e.touches[0];
            const dx = touch.clientX - bubbleDragStartX;
            const dy = touch.clientY - bubbleDragStartY;
            
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
                hasDraggedSignificantly = true;
            }

            let newX = bubbleInitialX + dx;
            let newY = bubbleInitialY + dy;

            newX = Math.max(0, Math.min(newX, window.innerWidth - 60));
            newY = Math.max(0, Math.min(newY, window.innerHeight - 60));

            bubbleEl.style.left = `${newX}px`;
            bubbleEl.style.top = `${newY}px`;
        }, { passive: true });

        bubbleEl.addEventListener('touchend', () => {
            if (isDraggingBubble) {
                isDraggingBubble = false;
                bubbleEl.style.transition = '';
                const rect = bubbleEl.getBoundingClientRect();
                localStorage.setItem(`chat_bubble_${spaceId}_x`, rect.left);
                localStorage.setItem(`chat_bubble_${spaceId}_y`, rect.top);
            }
        });

        // Click Handler opens chat panel, switches space, and enables semi-transparency
        bubbleEl.addEventListener('click', (e) => {
            if (e.target.classList.contains('chat-bubble-close')) return;
            if (hasDraggedSignificantly) return;

            if (chatPanel) {
                if (chatPanel.style.display === 'none' || chatPanel.style.display === '' || activeSpaceId !== spaceId) {
                    chatPanel.classList.add('semi-transparent');
                    isChatTransparent = true;
                    updateTransparencyIcon();
                    localStorage.setItem('chat_transparency', 'true');

                    chatPanel.style.display = 'flex';
                    selectChatSpace(spaceId, displayName);
                    
                    if (!hasFetchedChatSpaces) {
                        hasFetchedChatSpaces = true;
                        fetchChatSpaces();
                    }
                } else {
                    chatPanel.style.display = 'none';
                }
            }
        });
    }

    // Destroy specific chat bubble
    function destroyChatBubble(spaceId) {
        const bubble = activeBubbles[spaceId];
        if (bubble) {
            bubble.remove();
            delete activeBubbles[spaceId];
        }
        
        pinnedSpaces = pinnedSpaces.filter(s => s.id !== spaceId);
        localStorage.setItem('pinned_chat_spaces', JSON.stringify(pinnedSpaces));
        
        localStorage.removeItem(`chat_bubble_${spaceId}_x`);
        localStorage.removeItem(`chat_bubble_${spaceId}_y`);

        if (activeSpaceId === spaceId) {
            updatePinButtonState();
        }

        // Clean up global transparency style if there are no more active bubbles
        if (chatPanel && Object.keys(activeBubbles).length === 0) {
            chatPanel.classList.remove('semi-transparent');
            isChatTransparent = false;
            updateTransparencyIcon();
            localStorage.setItem('chat_transparency', 'false');
        }
    }

    // Sync badge for single bubble
    function syncBubbleBadge(spaceId) {
        const bubbleBadge = document.getElementById(`chat-bubble-badge-${spaceId}`);
        if (bubbleBadge) {
            const count = unreadCountsBySpace[spaceId] || 0;
            if (count > 0) {
                bubbleBadge.textContent = count > 99 ? '99+' : count;
                bubbleBadge.style.display = 'flex';
            } else {
                bubbleBadge.style.display = 'none';
            }
        }
    }

    // Sync badge for single chat space item in sidebar
    function syncSidebarSpaceBadge(spaceId) {
        const dot = document.getElementById(`chat-unread-dot-${spaceId}`);
        if (dot) {
            const count = unreadCountsBySpace[spaceId] || 0;
            dot.style.display = count > 0 ? 'block' : 'none';
        }
    }

    // Automatically spawn bubbles on load for already pinned chats
    pinnedSpaces.forEach(space => {
        spawnChatBubble(space.id, space.name);
    });

    // Gemini API Key Persistence
    const geminiApiKeyInput = document.getElementById('gemini-api-key');
    const savedApiKey = localStorage.getItem('gemini_api_key');
    if (savedApiKey) {
        geminiApiKeyInput.value = savedApiKey;
    }

    geminiApiKeyInput.addEventListener('change', (e) => {
        localStorage.setItem('gemini_api_key', e.target.value);
    });

    // --- Gemini Auto-Evaluation Rate ---
    function startGeminiAutoEval(rateMs) {
        if (geminiAutoEvalTimer) {
            clearInterval(geminiAutoEvalTimer);
            geminiAutoEvalTimer = null;
        }
        if (rateMs > 0) {
            geminiAutoEvalTimer = setInterval(() => {
                evaluateImportanceWithGemini(true); // silent = true
            }, rateMs);
            console.log(`[GeminiAutoEval] Timer avviato: ogni ${rateMs / 60000} minuti.`);
        } else {
            console.log('[GeminiAutoEval] Timer disabilitato.');
        }
    }

    const geminiAutoRateSelect = document.getElementById('gemini-auto-rate');
    const savedAutoRate = localStorage.getItem('gemini_auto_eval_rate') || '0';
    if (geminiAutoRateSelect) {
        geminiAutoRateSelect.value = savedAutoRate;
        startGeminiAutoEval(parseInt(savedAutoRate, 10));

        geminiAutoRateSelect.addEventListener('change', (e) => {
            const rate = parseInt(e.target.value, 10);
            localStorage.setItem('gemini_auto_eval_rate', e.target.value);
            startGeminiAutoEval(rate);
        });
    }

    const evaluateImportanceBtn = document.getElementById('evaluate-importance-btn');
    evaluateImportanceBtn.addEventListener('click', () => evaluateImportanceWithGemini(false));

    // State variables are declared at the top of DOMContentLoaded to avoid Temporal Dead Zone errors

    // Track previously seen chat message IDs for notifications
    const seenChatMessageIds = new Set();

    function showChatNotification(senderName, messageText, spaceId = null) {
        const container = document.getElementById('chat-notifications-container');
        if (!container) return;

        const notif = document.createElement('div');
        notif.className = 'chat-notification';
        notif.innerHTML = `
            <div class="chat-notification-header"><i class="fa-solid fa-message"></i> ${DOMPurify.sanitize(senderName)}</div>
            <div class="chat-notification-body">${DOMPurify.sanitize(messageText)}</div>
            <button class="chat-notification-close" aria-label="Chiudi">&times;</button>
        `;

        // Close button
        notif.querySelector('.chat-notification-close').addEventListener('click', (e) => {
            e.stopPropagation();
            notif.classList.add('fade-out');
            setTimeout(() => { if (container.contains(notif)) container.removeChild(notif); }, 400);
        });

        // Click on the notification container itself to open/select the chat
        notif.addEventListener('click', () => {
            if (chatPanel) {
                chatPanel.style.display = 'flex';
                if (spaceId) {
                    pendingSelectSpaceId = spaceId;
                    unreadCountsBySpace[spaceId] = 0;
                    if (typeof syncSidebarSpaceBadge === 'function') syncSidebarSpaceBadge(spaceId);
                    if (typeof syncBubbleBadge === 'function') syncBubbleBadge(spaceId);
                }
                unreadChatCount = Object.values(unreadCountsBySpace).reduce((a, b) => a + b, 0);
                updateChatBadge(false);
                
                if (!hasFetchedChatSpaces) {
                    hasFetchedChatSpaces = true;
                    fetchChatSpaces();
                } else if (spaceId) {
                    const space = allChatSpaces.find(s => s.name.endsWith('/' + spaceId));
                    if (space) {
                        selectChatSpace(spaceId, space.displayName || 'Direct Message');
                    }
                }
            }
            notif.classList.add('fade-out');
            setTimeout(() => { if (container.contains(notif)) container.removeChild(notif); }, 400);
        });

        container.appendChild(notif);

        // Auto remove after 7 seconds
        setTimeout(() => {
            if (!container.contains(notif)) return;
            notif.classList.add('fade-out');
            setTimeout(() => {
                if (container.contains(notif)) {
                    container.removeChild(notif);
                }
            }, 400); // wait for fade out transition
        }, 7000);
    }

    // State for Cloud Monitor folders and files expansion
    const cloudMonitorState = {
        openFolders: new Set(),
        openFiles: new Set()
    };
    const selectedEmailIds = new Set();
    const expandedEmailIds = new Set();
    const emailBodyScrollPositions = new Map();
    const selectedPairGroupKeys = new Set(); // tracks checked pair-box group keys across re-renders
    let openEscalationEmailId = null; // tracks which email's escalation dropdown is open
    let openReplyDropdownEmailId = null; // tracks which email's reply dropdown is open
    let lastCheckedEmailId = null; // tracks last checked email ID for Shift-selection

    // View Mode Selection
    const viewModeSelect = document.getElementById('view-mode-select');
    let viewMode = localStorage.getItem('view_mode') || 'native';
    viewModeSelect.value = viewMode;

    viewModeSelect.addEventListener('change', (e) => {
        viewMode = e.target.value;
        localStorage.setItem('view_mode', viewMode);
    });

    // --- Email Notes Logic ---
    // --- Email Notes Logic ---
    async function loadEmailNotes(emailId) {
        try {
            const response = await fetch(`/api/email-notes/${emailId}`);
            if (!response.ok) throw new Error('Failed to fetch email notes');
            const notes = await response.json();

            // 1. Refresh notes in full-email modal if open and showing this email
            const bodyContainer = document.getElementById('full-email-body');
            if (bodyContainer && bodyContainer.innerHTML !== '') {
                let notesSection = bodyContainer.querySelector('.email-notes-section');
                if (notesSection) {
                    const notesContainer = notesSection.querySelector('.email-notes-container');
                    renderEmailNotes(notes, notesContainer, emailId);
                    const formContainer = notesSection.querySelector('.email-note-form-container');
                    addEmailNoteUI(formContainer, emailId);
                }
            }

            // 2. Refresh notes in the standalone email notes modal if open for this email
            const notesModal = document.getElementById('email-notes-modal');
            const modalBody = document.getElementById('email-notes-modal-body');
            if (notesModal && notesModal.style.display === 'flex' && notesModal.dataset.emailId === emailId) {
                const notesContainer = modalBody.querySelector('.email-notes-container');
                if (notesContainer) {
                    renderEmailNotes(notes, notesContainer, emailId);
                }
                const formContainer = modalBody.querySelector('.email-note-form-container');
                if (formContainer) {
                    addEmailNoteUI(formContainer, emailId);
                }
            }

            // 3. Sync notes array in local memory cache
            const emailIndex = allEmails.findIndex(e => e.id === emailId);
            if (emailIndex !== -1) {
                allEmails[emailIndex].notes = notes;
                allEmails[emailIndex].hasNotes = notes.length > 0;
            }
            const pinnedIndex = pinnedEmails.findIndex(e => e.id === emailId);
            if (pinnedIndex !== -1) {
                pinnedEmails[pinnedIndex].notes = notes;
                pinnedEmails[pinnedIndex].hasNotes = notes.length > 0;
            }

            // 4. Update DOM items dynamically
            updateEmailItemNotesDOM(emailId, notes);

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
        div.dataset.noteId = note.id;

        div.innerHTML = `
            <div class="email-note-meta">
                <span class="email-note-user"><i class="fa-solid fa-user"></i> ${DOMPurify.sanitize(note.userId)}</span>
                <span class="email-note-date">${new Date(note.createdAt).toLocaleString()}</span>
            </div>
            <div class="email-note-item-actions">
                <button class="email-note-edit-btn" title="Modifica nota"><i class="fa-solid fa-pen-to-square"></i></button>
                <button class="email-note-delete-btn" title="Elimina nota"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div class="email-note-content-container">
                <div class="email-note-content">${DOMPurify.sanitize(note.content)}</div>
            </div>
            ${!isReply ? `
                <div class="email-note-actions">
                    <button class="email-note-reply-btn" data-parent-id="${note.id}">
                        <i class="fa-solid fa-reply"></i> Rispondi
                    </button>
                </div>
                <div class="reply-form-container" id="reply-form-${note.id}"></div>
            ` : ''}
        `;

        // Delete note handler
        const deleteBtn = div.querySelector('.email-note-delete-btn');
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmMsg = isReply 
                ? 'Sei sicuro di voler eliminare questa risposta?' 
                : 'Sei sicuro di voler eliminare questa nota e tutte le sue risposte?';
            if (!confirm(confirmMsg)) return;

            try {
                const response = await fetch(`/api/email-notes/${emailId}/${note.id}`, {
                    method: 'DELETE'
                });
                if (!response.ok) throw new Error('Errore durante la cancellazione della nota');
                
                // Refresh notes
                await loadEmailNotes(emailId);
            } catch (err) {
                console.error('Error deleting note:', err);
                alert('Impossibile eliminare la nota.');
            }
        });

        // Edit note handler
        const editBtn = div.querySelector('.email-note-edit-btn');
        const contentContainer = div.querySelector('.email-note-content-container');
        
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // Check if already in edit mode
            if (contentContainer.querySelector('.email-note-edit-form')) return;
            
            const originalContent = note.content;
            
            contentContainer.innerHTML = `
                <div class="email-note-edit-form mt-2">
                    <textarea class="form-control mb-1" style="min-height: 60px; font-size: 0.9rem;">${originalContent}</textarea>
                    <div class="d-flex justify-content-end gap-1">
                        <button class="btn btn-xs btn-primary save-edit-btn" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;"><i class="fa-solid fa-save"></i> Salva</button>
                        <button class="btn btn-xs btn-secondary cancel-edit-btn" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;"><i class="fa-solid fa-times"></i> Annulla</button>
                    </div>
                </div>
            `;
            
            const textarea = contentContainer.querySelector('textarea');
            const saveEditBtn = contentContainer.querySelector('.save-edit-btn');
            const cancelEditBtn = contentContainer.querySelector('.cancel-edit-btn');
            
            textarea.focus();
            
            cancelEditBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                contentContainer.innerHTML = `<div class="email-note-content">${DOMPurify.sanitize(originalContent)}</div>`;
            });
            
            saveEditBtn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const newContent = textarea.value.trim();
                if (!newContent) return;
                
                try {
                    const response = await fetch(`/api/email-notes/${emailId}/${note.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: newContent })
                    });
                    if (!response.ok) throw new Error('Errore durante la modifica della nota');
                    
                    // Refresh notes
                    await loadEmailNotes(emailId);
                } catch (err) {
                    console.error('Error saving note edit:', err);
                    alert('Impossibile salvare la modifica.');
                }
            });
        });

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
            await loadEmailNotes(emailId);
        } catch (error) {
            console.error('Error saving email note:', error);
            alert('Errore durante il salvataggio della nota.');
        }
    }

    function renderNotesPreview(notes, container, emailId) {
        container.innerHTML = '';
        if (!notes || notes.length === 0) {
            container.innerHTML = `<span class="add-note-placeholder"><i class="fa-solid fa-plus"></i> Aggiungi nota</span>`;
            container.classList.add('empty');
            return;
        }
        container.classList.remove('empty');

        const topLevelNotes = notes.filter(n => !n.parentId);
        if (topLevelNotes.length > 0) {
            const latestNote = topLevelNotes[topLevelNotes.length - 1];
            const contentText = latestNote.content.length > 50 ? latestNote.content.substring(0, 50) + '...' : latestNote.content;
            
            container.innerHTML = `
                <div class="compact-note-bubble" title="${DOMPurify.sanitize(latestNote.content)}">
                    <span class="note-user"><i class="fa-solid fa-user"></i> ${DOMPurify.sanitize(latestNote.userId)}:</span>
                    <span class="note-text">${DOMPurify.sanitize(contentText)}</span>
                    ${topLevelNotes.length > 1 ? `<span class="note-count">+${topLevelNotes.length - 1} note</span>` : ''}
                </div>
            `;
        }
    }

    function updateEmailItemNotesDOM(emailId, notes) {
        const emailItems = document.querySelectorAll(`.email-item[data-id="${emailId}"]`);
        emailItems.forEach(emailItem => {
            const checkboxContainer = emailItem.querySelector('.checkbox-wrapper');
            if (checkboxContainer) {
                let badge = checkboxContainer.querySelector('.note-indicator-badge');
                if (notes.length > 0) {
                    if (!badge) {
                        badge = document.createElement('div');
                        badge.className = 'note-indicator-badge';
                        badge.innerHTML = '<i class="fa-solid fa-note-sticky"></i>';
                        badge.title = 'Questa email ha delle note';
                        checkboxContainer.appendChild(badge);
                    }
                } else {
                    if (badge) badge.remove();
                }
            }

            const previewContainer = emailItem.querySelector('.email-notes-preview');
            if (previewContainer) {
                renderNotesPreview(notes, previewContainer, emailId);
            }
        });
    }

    async function openEmailNotesModal(email) {
        const modal = document.getElementById('email-notes-modal');
        const bodyContainer = document.getElementById('email-notes-modal-body');
        if (!modal || !bodyContainer) return;

        modal.dataset.emailId = email.id;
        bodyContainer.innerHTML = `
            <div class="email-notes-meta mb-3" style="border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">
                <p class="mb-1"><strong>Oggetto:</strong> ${DOMPurify.sanitize(email.subject)}</p>
                <p class="mb-0 text-muted small"><strong>Da:</strong> ${DOMPurify.sanitize(email.from)}</p>
            </div>
            <div class="email-notes-section">
                <div class="email-notes-container">Caricamento note...</div>
                <div class="email-note-form-container"></div>
            </div>
        `;
        modal.style.display = 'flex';

        await loadEmailNotes(email.id);
    }

    function closeEmailNotesModal() {
        const modal = document.getElementById('email-notes-modal');
        if (modal) {
            modal.style.display = 'none';
            delete modal.dataset.emailId;
        }
    }

    // --- Logout
    // The previous implementation used axios which was not defined.
    // We already have a correct logout listener at the end of DOMContentLoaded.

    // Hide AIUTO button if not needed (optional based on user request to "clean up")
    // Account & Email Notes Modal Logic
    const accountModal = document.getElementById('account-modal');
    const accountBtn = document.getElementById('account-window-btn');
    const closeAccountBtn = document.getElementById('close-account-modal');
    const closeEmailNotesBtn = document.getElementById('close-email-notes-modal');

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

    if (closeEmailNotesBtn) {
        closeEmailNotesBtn.addEventListener('click', () => {
            closeEmailNotesModal();
        });
    }

    // Close modal and dropdowns on click outside
    window.addEventListener('click', (event) => {
        if (event.target === accountModal) {
            accountModal.style.display = 'none';
        }
        if (event.target === document.getElementById('score-rules-modal')) {
            document.getElementById('score-rules-modal').style.display = 'none';
            accountModal.style.display = 'flex';
        }
        if (event.target === document.getElementById('mfa-setup-modal')) {
            document.getElementById('mfa-setup-modal').style.display = 'none';
        }
        if (event.target === document.getElementById('email-notes-modal')) {
            closeEmailNotesModal();
        }
        
        // Close escalation dropdowns when clicking outside
        if (!event.target.closest('.escalation-dropdown')) {
            document.querySelectorAll('.escalation-dropdown.show').forEach(d => {
                d.classList.remove('show');
            });
            openEscalationEmailId = null;
        }
        // Close reply dropdowns when clicking outside
        if (!event.target.closest('.reply-dropdown')) {
            document.querySelectorAll('.reply-dropdown.show').forEach(d => {
                d.classList.remove('show');
            });
            openReplyDropdownEmailId = null;
        }
    });

    // --- Gestione Regole Score Email ---
    const scoreRulesModal = document.getElementById('score-rules-modal');
    const manageScoreRulesBtn = document.getElementById('manage-score-rules-btn');
    const closeScoreRulesBtn = document.getElementById('close-score-rules-modal');
    const addScoreRuleBtn = document.getElementById('add-score-rule-btn');
    const cancelScoreRuleBtn = document.getElementById('cancel-score-rule-btn');
    const saveScoreRuleBtn = document.getElementById('save-score-rule-btn');
    const scoreRuleFormContainer = document.getElementById('score-rule-form-container');
    const scoreRulesTableBody = document.getElementById('score-rules-table-body');

    if (manageScoreRulesBtn && scoreRulesModal) {
        manageScoreRulesBtn.addEventListener('click', () => {
            accountModal.style.display = 'none'; // Chiudi modale impostazioni per fare spazio
            scoreRulesModal.style.display = 'flex';
            loadScoreRules();
        });
    }

    if (closeScoreRulesBtn && scoreRulesModal) {
        closeScoreRulesBtn.addEventListener('click', () => {
            scoreRulesModal.style.display = 'none';
            accountModal.style.display = 'flex'; // Riapri modale impostazioni
        });
    }

    if (addScoreRuleBtn) {
        addScoreRuleBtn.addEventListener('click', () => {
            resetScoreRuleForm();
            document.getElementById('score-rule-form-title').textContent = "Nuova Regola";
            scoreRuleFormContainer.classList.remove('d-none');
            scoreRuleFormContainer.scrollIntoView({ behavior: 'smooth' });
        });
    }

    if (cancelScoreRuleBtn) {
        cancelScoreRuleBtn.addEventListener('click', () => {
            resetScoreRuleForm();
        });
    }

    if (saveScoreRuleBtn) {
        saveScoreRuleBtn.addEventListener('click', async () => {
            const ruleId = document.getElementById('score-rule-id').value;
            const name = document.getElementById('score-rule-name').value.trim();
            const field = document.getElementById('score-rule-field').value;
            const operator = document.getElementById('score-rule-operator').value;
            const value = document.getElementById('score-rule-value').value.trim();
            const score = parseFloat(document.getElementById('score-rule-score').value);

            if (!name || value === "") {
                showToast("Nome regola e valore di match sono obbligatori.", "error");
                return;
            }

            if (isNaN(score) || score < 0.0 || score > 1.0) {
                showToast("Lo score deve essere un numero compreso tra 0.0 e 1.0.", "error");
                return;
            }

            // Se è regex, valida l'espressione prima di salvare
            if (operator === 'regex') {
                try {
                    new RegExp(value);
                } catch (e) {
                    showToast("Espressione regolare non valida.", "error");
                    return;
                }
            }

            if (ruleId) {
                // Modifica regola esistente
                const index = scoreRules.findIndex(r => r.id === ruleId);
                if (index !== -1) {
                    scoreRules[index] = {
                        ...scoreRules[index],
                        name,
                        field,
                        operator,
                        value,
                        score
                    };
                }
            } else {
                // Nuova regola
                const newRule = {
                    id: 'rule_' + Date.now(),
                    name,
                    field,
                    operator,
                    value,
                    score,
                    active: true
                };
                scoreRules.push(newRule);
            }

            const success = await saveScoreRulesList(scoreRules);
            if (success) {
                resetScoreRuleForm();
                renderScoreRulesTable();
                // Ricarica le email in background per mostrare i nuovi score aggiornati
                fetchAndDisplayEmails(true);
            }
        });
    }

    async function loadScoreRules() {
        try {
            const response = await fetch('/api/score-rules');
            if (!response.ok) throw new Error('Impossibile caricare le regole.');
            scoreRules = await response.json();
            renderScoreRulesTable();
        } catch (error) {
            console.error('Error loading score rules:', error);
            showToast("Errore durante il caricamento delle regole.", "error");
        }
    }

    async function saveScoreRulesList(rulesList) {
        try {
            const response = await fetch('/api/score-rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rulesList)
            });
            if (!response.ok) {
                const errMsg = await response.text();
                throw new Error(errMsg || 'Impossibile salvare le regole.');
            }
            showToast("Regole salvate e applicate con successo.");
            return true;
        } catch (error) {
            console.error('Error saving score rules:', error);
            showToast(`Errore durante il salvataggio: ${error.message}`, "error");
            return false;
        }
    }

    function resetScoreRuleForm() {
        document.getElementById('score-rule-id').value = '';
        document.getElementById('score-rule-name').value = '';
        document.getElementById('score-rule-field').value = 'any';
        document.getElementById('score-rule-operator').value = 'contains';
        document.getElementById('score-rule-value').value = '';
        document.getElementById('score-rule-score').value = '0.9';
        scoreRuleFormContainer.classList.add('d-none');
    }

    function renderScoreRulesTable() {
        if (!scoreRulesTableBody) return;
        scoreRulesTableBody.innerHTML = '';

        if (scoreRules.length === 0) {
            scoreRulesTableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center text-muted py-3">Nessuna regola configurata. Clicca su "Nuova Regola" per iniziare.</td>
                </tr>
            `;
            return;
        }

        scoreRules.forEach((rule, index) => {
            const tr = document.createElement('tr');
            
            // Traduzione etichette campi
            const fieldLabels = {
                any: 'Qualsiasi',
                subject: 'Oggetto',
                from: 'Mittente',
                body: 'Corpo'
            };
            const opLabels = {
                contains: 'Contiene',
                equals: 'Uguale a',
                regex: 'Regex'
            };

            const fieldLabel = fieldLabels[rule.field] || rule.field;
            const opLabel = opLabels[rule.operator] || rule.operator;

            const isFirst = index === 0;
            const isLast = index === scoreRules.length - 1;

            tr.innerHTML = `
                <td>
                    <div class="form-check form-switch m-0">
                        <input class="form-check-input toggle-rule-active-btn" type="checkbox" data-index="${index}" ${rule.active ? 'checked' : ''}>
                    </div>
                </td>
                <td class="fw-bold">${DOMPurify.sanitize(rule.name)}</td>
                <td><span class="badge bg-secondary">${DOMPurify.sanitize(fieldLabel)}</span></td>
                <td><span class="badge bg-info text-dark">${DOMPurify.sanitize(opLabel)}</span></td>
                <td><code>${DOMPurify.sanitize(rule.value)}</code></td>
                <td><strong class="text-primary">${rule.score.toFixed(2)}</strong></td>
                <td class="text-center">
                    <div class="d-flex justify-content-center gap-1">
                        <button class="btn btn-xs btn-outline-warning edit-rule-btn" data-index="${index}" title="Modifica"><i class="fa-solid fa-pen"></i></button>
                        <button class="btn btn-xs btn-outline-danger delete-rule-btn" data-index="${index}" title="Elimina"><i class="fa-solid fa-trash"></i></button>
                        <button class="btn btn-xs btn-outline-secondary move-rule-btn" data-index="${index}" data-dir="up" ${isFirst ? 'disabled' : ''} title="Sposta Su"><i class="fa-solid fa-arrow-up"></i></button>
                        <button class="btn btn-xs btn-outline-secondary move-rule-btn" data-index="${index}" data-dir="down" ${isLast ? 'disabled' : ''} title="Sposta Giù"><i class="fa-solid fa-arrow-down"></i></button>
                    </div>
                </td>
            `;

            // Attacca i listener
            tr.querySelector('.toggle-rule-active-btn').addEventListener('change', (e) => {
                const idx = parseInt(e.target.dataset.index, 10);
                toggleScoreRuleActive(idx, e.target.checked);
            });

            tr.querySelector('.edit-rule-btn').addEventListener('click', (e) => {
                const btn = e.target.closest('.edit-rule-btn');
                const idx = parseInt(btn.dataset.index, 10);
                editScoreRule(idx);
            });

            tr.querySelector('.delete-rule-btn').addEventListener('click', (e) => {
                const btn = e.target.closest('.delete-rule-btn');
                const idx = parseInt(btn.dataset.index, 10);
                deleteScoreRule(idx);
            });

            tr.querySelectorAll('.move-rule-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const button = e.target.closest('.move-rule-btn');
                    if (button.disabled) return;
                    const idx = parseInt(button.dataset.index, 10);
                    const direction = button.dataset.dir;
                    moveScoreRule(idx, direction);
                });
            });

            scoreRulesTableBody.appendChild(tr);
        });
    }

    function editScoreRule(index) {
        const rule = scoreRules[index];
        if (!rule) return;

        document.getElementById('score-rule-id').value = rule.id;
        document.getElementById('score-rule-name').value = rule.name;
        document.getElementById('score-rule-field').value = rule.field;
        document.getElementById('score-rule-operator').value = rule.operator;
        document.getElementById('score-rule-value').value = rule.value;
        document.getElementById('score-rule-score').value = rule.score;

        document.getElementById('score-rule-form-title').textContent = "Modifica Regola";
        scoreRuleFormContainer.classList.remove('d-none');
        scoreRuleFormContainer.scrollIntoView({ behavior: 'smooth' });
    }

    async function deleteScoreRule(index) {
        if (!confirm(`Sei sicuro di voler eliminare la regola "${scoreRules[index].name}"?`)) return;
        scoreRules.splice(index, 1);
        const success = await saveScoreRulesList(scoreRules);
        if (success) {
            renderScoreRulesTable();
            fetchAndDisplayEmails(true);
        }
    }

    async function toggleScoreRuleActive(index, isActive) {
        scoreRules[index].active = isActive;
        const success = await saveScoreRulesList(scoreRules);
        if (success) {
            fetchAndDisplayEmails(true);
        }
    }

    async function moveScoreRule(index, direction) {
        let targetIndex = -1;
        if (direction === 'up' && index > 0) {
            targetIndex = index - 1;
        } else if (direction === 'down' && index < scoreRules.length - 1) {
            targetIndex = index + 1;
        }

        if (targetIndex !== -1) {
            const temp = scoreRules[index];
            scoreRules[index] = scoreRules[targetIndex];
            scoreRules[targetIndex] = temp;
            
            const success = await saveScoreRulesList(scoreRules);
            if (success) {
                renderScoreRulesTable();
                fetchAndDisplayEmails(true);
            }
        }
    }

    // AutoBlock Dashboard Logic
    const autoblockBtn = document.getElementById('autoblock-dashboard-btn');
    if (autoblockBtn) {
        autoblockBtn.addEventListener('click', () => {
            window.open('/autoblock/', '_blank');
        });
    }

    // --- Redmine Support Dashboard Logic ---
    let rawRedmineIssues = [];
    let openTickets = [];
    let currentEmailForLink = null;
    let selectedTicketForLink = null;

    function cleanSubjectForComparison(subject) {
        if (!subject) return '';
        return subject
            .replace(/^(re|fwd|i|r|aw|antwort|vs|tr|wg):\s*/i, '')
            .replace(/^\[.*?\]\s*/g, '')
            .trim()
            .toLowerCase();
    }

    function isIssueClosed(issue) {
        if (!issue || !issue.status) return false;
        if (issue.status.is_closed !== undefined) {
            return issue.status.is_closed;
        }
        // Fallback per compatibilità
        return issue.status.id === 5 || issue.status.name.toLowerCase() === 'chiuso' || !!issue.closed_on;
    }

    let lastOpenTicketsFetchTime = 0;
    const OPEN_TICKETS_CACHE_DURATION = 30000; // 30 secondi cache locale

    async function loadOpenTickets(force = false) {
        const now = Date.now();
        if (!force && openTickets.length > 0 && (now - lastOpenTicketsFetchTime) < OPEN_TICKETS_CACHE_DURATION) {
            return;
        }
        try {
            const response = await fetch('/api/redmine/open-tickets');
            if (response.ok) {
                openTickets = await response.json();
                lastOpenTicketsFetchTime = now;
                console.log(`Caricati ${openTickets.length} ticket aperti (L1/L2).`);
            }
        } catch (err) {
            console.error('Errore nel caricamento dei ticket aperti Redmine:', err);
        }
    }

    let redmineChartInstance = null;
    let redmineDistributionChartInstance = null;
    let redmineHeatmapChartInstance = null;
    let redmineCategoryPieChartInstance = null;
    let fullscreenHeatmapChartInstance = null;
    let currentIssuesForHeatmap = [];

    // Redmine Button Click handler
    const redmineBtn = document.getElementById('redmine-dashboard-btn');
    if (redmineBtn) {
        redmineBtn.addEventListener('click', () => {
            showTab('redmine');
        });
    }

    // Refresh Button Click handler
    const redmineRefreshBtn = document.getElementById('redmine-refresh-btn');
    if (redmineRefreshBtn) {
        redmineRefreshBtn.addEventListener('click', () => {
            loadRedmineDashboard(true);
        });
    }

    // Project filter selection change handler
    const redmineProjectSelect = document.getElementById('redmine-project-select');
    if (redmineProjectSelect) {
        redmineProjectSelect.addEventListener('change', () => {
            applyRedmineFilters();
        });
    }

    // Period filter and custom date selection handlers
    const redminePeriodSelect = document.getElementById('redmine-period-select');
    const redmineCustomDateContainer = document.getElementById('redmine-custom-date-container');
    const redmineDateStart = document.getElementById('redmine-date-start');
    const redmineDateEnd = document.getElementById('redmine-date-end');

    // Pre-fill custom dates with default values (last month to today)
    if (redmineDateStart && !redmineDateStart.value) {
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        redmineDateStart.value = oneMonthAgo.toISOString().substring(0, 10);
    }
    if (redmineDateEnd && !redmineDateEnd.value) {
        redmineDateEnd.value = new Date().toISOString().substring(0, 10);
    }

    if (redminePeriodSelect) {
        redminePeriodSelect.addEventListener('change', function() {
            if (this.value === 'custom') {
                redmineCustomDateContainer.classList.remove('d-none');
                redmineCustomDateContainer.classList.add('d-flex');
            } else {
                redmineCustomDateContainer.classList.add('d-none');
                redmineCustomDateContainer.classList.remove('d-flex');
            }
            applyRedmineFilters();
        });
    }

    if (redmineDateStart) {
        redmineDateStart.addEventListener('change', () => {
            applyRedmineFilters();
        });
    }
    if (redmineDateEnd) {
        redmineDateEnd.addEventListener('change', () => {
            applyRedmineFilters();
        });
    }

    function getPeriodDates(periodValue) {
        const end = new Date();
        end.setHours(23, 59, 59, 999);
        
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        
        switch (periodValue) {
            case 'oggi':
                // start is today 00:00
                break;
            case '3d':
                start.setDate(start.getDate() - 2);
                break;
            case '1w':
                start.setDate(start.getDate() - 6);
                break;
            case '15d':
                start.setDate(start.getDate() - 14);
                break;
            case '1m':
                start.setMonth(start.getMonth() - 1);
                break;
            case '3m':
                start.setMonth(start.getMonth() - 3);
                break;
            case '6m':
                start.setMonth(start.getMonth() - 6);
                break;
            case '1y':
                start.setFullYear(start.getFullYear() - 1);
                break;
            case 'custom':
                if (redmineDateStart && redmineDateStart.value) {
                    const dStart = new Date(redmineDateStart.value);
                    dStart.setHours(0, 0, 0, 0);
                    start.setTime(dStart.getTime());
                } else {
                    start.setMonth(start.getMonth() - 6);
                }
                if (redmineDateEnd && redmineDateEnd.value) {
                    const dEnd = new Date(redmineDateEnd.value);
                    dEnd.setHours(23, 59, 59, 999);
                    end.setTime(dEnd.getTime());
                }
                break;
        }
        return { start, end };
    }

    function applyRedmineFilters() {
        if (!redmineProjectSelect) return;
        const selectedProj = redmineProjectSelect.value;
        let filtered = rawRedmineIssues;
        if (selectedProj !== 'all') {
            const projId = parseInt(selectedProj, 10);
            filtered = rawRedmineIssues.filter(issue => issue.project && issue.project.id === projId);
        }
        const periodVal = redminePeriodSelect ? redminePeriodSelect.value : '6m';
        const { start, end } = getPeriodDates(periodVal);
        renderRedmineDashboardData(filtered, start, end);
        loadTriageOperatorEfficiency(start, end);
    }

    async function loadRedmineDashboard(forceRefresh = false) {
        const kpiTotal = document.getElementById('redmine-kpi-total');
        const kpiOpen = document.getElementById('redmine-kpi-open');
        const kpiUrgent = document.getElementById('redmine-kpi-urgent');
        const kpiOverdue = document.getElementById('redmine-kpi-overdue');
        const criticalTableBody = document.getElementById('redmine-critical-table-body');
        const unassignedTbody = document.getElementById('redmine-unassigned-table-body');
        const workloadTbody = document.getElementById('redmine-user-workload-table-body');

        if (kpiTotal) kpiTotal.textContent = '...';
        if (kpiOpen) kpiOpen.textContent = '...';
        if (kpiUrgent) kpiUrgent.textContent = '...';
        if (kpiOverdue) kpiOverdue.textContent = '...';
        if (criticalTableBody) {
            criticalTableBody.innerHTML = `
                <tr>
                    <td colspan="5" class="text-center py-4">
                        <div class="spinner-border spinner-border-sm text-warning" role="status"></div>
                        <span class="ms-2">Caricamento dati da Redmine in corso...</span>
                    </td>
                </tr>
            `;
        }
        if (unassignedTbody) {
            unassignedTbody.innerHTML = `
                <tr>
                    <td colspan="5" class="text-center py-4">
                        <div class="spinner-border spinner-border-sm text-warning" role="status"></div>
                        <span class="ms-2">Caricamento in corso...</span>
                    </td>
                </tr>
            `;
        }
        if (workloadTbody) {
            workloadTbody.innerHTML = `
                <tr>
                    <td colspan="2" class="text-center py-4">
                        <div class="spinner-border spinner-border-sm text-warning" role="status"></div>
                        <span class="ms-2">Caricamento in corso...</span>
                    </td>
                </tr>
            `;
        }

        try {
            const url = '/api/redmine/dashboard-data' + (forceRefresh ? '?refresh=true' : '');
            const response = await fetch(url);
            if (!response.ok) throw new Error('Fallito il recupero dati Redmine');
            const data = await response.json();
            
            rawRedmineIssues = data.issues || [];
            applyRedmineFilters();
        } catch (err) {
            console.error('Errore caricamento dashboard Redmine:', err);
            if (criticalTableBody) {
                criticalTableBody.innerHTML = `
                    <tr>
                        <td colspan="5" class="text-center py-4 text-danger">
                            <i class="fa-solid fa-triangle-exclamation me-2"></i> Impossibile recuperare i dati da Redmine: ${err.message}
                        </td>
                    </tr>
                `;
            }
            if (unassignedTbody) {
                unassignedTbody.innerHTML = `
                    <tr>
                        <td colspan="5" class="text-center py-4 text-danger">
                            <i class="fa-solid fa-triangle-exclamation me-2"></i> Impossibile recuperare i dati: ${err.message}
                        </td>
                    </tr>
                `;
            }
            if (workloadTbody) {
                workloadTbody.innerHTML = `
                    <tr>
                        <td colspan="2" class="text-center py-4 text-danger">
                            <i class="fa-solid fa-triangle-exclamation me-2"></i> Impossibile recuperare i dati: ${err.message}
                        </td>
                    </tr>
                `;
            }
        }
    }

    function getIssueCategory(issue) {
        if (issue.custom_fields) {
            const catField = issue.custom_fields.find(cf => cf.name === 'Categoria' || cf.name === 'Category');
            if (catField && catField.value) {
                return catField.value;
            }
        }
        if (issue.category && issue.category.name) {
            return issue.category.name;
        }
        return "Non specificata";
    }

    async function loadTriageOperatorEfficiency(start, end) {
        const tbody = document.getElementById('redmine-triage-efficiency-table-body');
        if (!tbody) return;

        tbody.innerHTML = `
            <tr>
                <td colspan="4" class="text-center py-4">
                    <div class="spinner-border spinner-border-sm text-warning" role="status"></div>
                    <span class="ms-2">Caricamento dati di triage...</span>
                </td>
            </tr>
        `;

        try {
            const startISO = start.toISOString();
            const endISO = end.toISOString();
            const response = await fetch(`/api/redmine/triage-efficiency?start=${startISO}&end=${endISO}`);
            if (!response.ok) throw new Error('Fallito il recupero dell\'efficienza triage');
            const data = await response.json();

            tbody.innerHTML = '';
            if (data.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="4" class="text-center py-4 text-muted">
                            Nessuna attività registrata per questo periodo.
                        </td>
                    </tr>
                `;
            } else {
                data.forEach(dayRecord => {
                    const localDateStr = new Date(dayRecord.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
                    dayRecord.operators.forEach((opRecord, index) => {
                        const tr = document.createElement('tr');
                        
                        if (index === 0) {
                            const dateTd = document.createElement('td');
                            dateTd.setAttribute('rowspan', dayRecord.operators.length);
                            dateTd.className = 'fw-semibold text-secondary';
                            dateTd.textContent = localDateStr;
                            tr.appendChild(dateTd);
                        }
                        
                        const opTd = document.createElement('td');
                        opTd.className = 'fw-semibold text-primary';
                        opTd.textContent = opRecord.operator;
                        tr.appendChild(opTd);

                        const emailsTd = document.createElement('td');
                        emailsTd.className = 'text-center fw-semibold text-success';
                        emailsTd.textContent = opRecord.emailsManaged;
                        tr.appendChild(emailsTd);

                        const ticketsTd = document.createElement('td');
                        ticketsTd.className = 'text-center fw-semibold text-info';
                        ticketsTd.textContent = opRecord.ticketsOpened;
                        tr.appendChild(ticketsTd);

                        tbody.appendChild(tr);
                    });
                });
            }
        } catch (err) {
            console.error('Errore caricamento efficienza triage:', err);
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center py-4 text-danger">
                        <i class="fa-solid fa-triangle-exclamation me-2"></i> Errore nel caricamento dei dati: ${err.message}
                    </td>
                </tr>
            `;
        }
    }

    function renderRedmineCategoryStats(openIssues, urgentIssues, overdueIssues, closedInPeriod) {
        const categoryKpis = {};
        const openCount = openIssues.length;
        const urgentCount = urgentIssues.length;
        const overdueCount = overdueIssues.length;
        
        openIssues.forEach(issue => {
            const cat = getIssueCategory(issue);
            if (!categoryKpis[cat]) {
                categoryKpis[cat] = { open: 0, urgent: 0, overdue: 0 };
            }
            categoryKpis[cat].open++;
        });
        
        urgentIssues.forEach(issue => {
            const cat = getIssueCategory(issue);
            if (!categoryKpis[cat]) {
                categoryKpis[cat] = { open: 0, urgent: 0, overdue: 0 };
            }
            categoryKpis[cat].urgent++;
        });
        
        overdueIssues.forEach(issue => {
            const cat = getIssueCategory(issue);
            if (!categoryKpis[cat]) {
                categoryKpis[cat] = { open: 0, urgent: 0, overdue: 0 };
            }
            categoryKpis[cat].overdue++;
        });
        
        const categoryKpiTbody = document.getElementById('redmine-category-kpi-table-body');
        if (categoryKpiTbody) {
            categoryKpiTbody.innerHTML = '';
            const categories = Object.keys(categoryKpis);
            if (categories.length === 0) {
                categoryKpiTbody.innerHTML = `
                    <tr>
                        <td colspan="4" class="text-center py-4 text-muted">
                            Nessun ticket in gestione rilevato per questo periodo.
                        </td>
                    </tr>
                `;
            } else {
                categories.sort().forEach(cat => {
                    const stats = categoryKpis[cat];
                    const openPctStr = openCount > 0 ? `${Math.round((stats.open / openCount) * 100)}%` : '0%';
                    const urgentPctStr = urgentCount > 0 ? `${Math.round((stats.urgent / urgentCount) * 100)}%` : '0%';
                    const overduePctStr = overdueCount > 0 ? `${Math.round((stats.overdue / overdueCount) * 100)}%` : '0%';
                    
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="fw-semibold text-secondary">${DOMPurify.sanitize(cat)}</td>
                        <td class="text-center fw-semibold text-success">${stats.open} <span class="text-muted small">(${openPctStr})</span></td>
                        <td class="text-center fw-semibold text-danger">${stats.urgent} <span class="text-muted small">(${urgentPctStr})</span></td>
                        <td class="text-center fw-semibold text-warning">${stats.overdue} <span class="text-muted small">(${overduePctStr})</span></td>
                    `;
                    categoryKpiTbody.appendChild(tr);
                });
            }

            // Render Pie Chart for category distribution of open/in-gestione issues
            const pieCanvas = document.getElementById('redmine-category-pie-chart');
            if (pieCanvas) {
                if (redmineCategoryPieChartInstance) {
                    redmineCategoryPieChartInstance.destroy();
                }

                const isDarkMode = document.body.classList.contains('dark-mode');
                const textColor = isDarkMode ? '#9ca3af' : '#4b5563';
                
                const categories = Object.keys(categoryKpis).sort();
                const openCounts = categories.map(cat => categoryKpis[cat].open);

                const ctx = pieCanvas.getContext('2d');
                redmineCategoryPieChartInstance = new Chart(ctx, {
                    type: 'pie',
                    data: {
                        labels: categories,
                        datasets: [{
                            data: openCounts,
                            backgroundColor: [
                                '#3b82f6', // blue
                                '#10b981', // green
                                '#f59e0b', // amber
                                '#ef4444', // red
                                '#8b5cf6', // purple
                                '#ec4899', // pink
                                '#06b6d4', // cyan
                                '#6b7280'  // grey
                            ],
                            borderWidth: isDarkMode ? 2 : 1,
                            borderColor: isDarkMode ? '#1e2530' : '#ffffff'
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                position: 'bottom',
                                labels: {
                                    color: textColor,
                                    font: { family: 'Poppins', size: 9 },
                                    boxWidth: 8,
                                    usePointStyle: true
                                }
                            },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        const label = context.label || '';
                                        const value = context.parsed || 0;
                                        const stats = categoryKpis[label];
                                        if (stats) {
                                            const openPct = openCount > 0 ? Math.round((stats.open / openCount) * 100) : 0;
                                            return [
                                                ` In Gestione: ${stats.open} (${openPct}%)`,
                                                ` Urgenti (Alta): ${stats.urgent}`,
                                                ` Arretrati (+2gg): ${stats.overdue}`
                                            ];
                                        }
                                        return ` ${label}: ${value}`;
                                    }
                                }
                            }
                        }
                    }
                });
            }
        }

        const categoryStats = {};
        closedInPeriod.forEach(i => {
            if (i.computed && i.computed.mttr !== null) {
                const category = getIssueCategory(i);
                if (!categoryStats[category]) {
                    categoryStats[category] = { totalMttr: 0, count: 0 };
                }
                categoryStats[category].totalMttr += i.computed.mttr;
                categoryStats[category].count++;
            }
        });

        const categoryTbody = document.getElementById('redmine-mttr-category-table-body');
        if (categoryTbody) {
            categoryTbody.innerHTML = '';
            const categories = Object.keys(categoryStats);
            if (categories.length === 0) {
                categoryTbody.innerHTML = `
                    <tr>
                        <td colspan="3" class="text-center py-4 text-muted">
                            Nessun dato di risoluzione per questo periodo.
                        </td>
                    </tr>
                `;
            } else {
                categories.sort().forEach(cat => {
                    const stats = categoryStats[cat];
                    const avg = stats.totalMttr / stats.count;
                    const mttrHours = avg / (60 * 60 * 1000);
                    let avgStr = '';
                    if (mttrHours < 24) {
                        avgStr = `${mttrHours.toFixed(1)} ore`;
                    } else {
                        avgStr = `${(mttrHours / 24).toFixed(1)} gg`;
                    }

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="fw-semibold text-secondary">${DOMPurify.sanitize(cat)}</td>
                        <td class="text-center">${stats.count}</td>
                        <td class="text-center text-info fw-semibold">${avgStr}</td>
                    `;
                    categoryTbody.appendChild(tr);
                });
            }
        }
    }

    function renderRedmineDashboardData(issues, start, end) {
        // Filter subsets based on start and end
        const createdInPeriod = issues.filter(i => {
            const d = new Date(i.created_on);
            return d >= start && d <= end;
        });

        const closedInPeriod = issues.filter(i => {
            const isClosed = isIssueClosed(i);
            const closedDate = i.closed_on ? new Date(i.closed_on) : (i.computed && i.computed.closedOn ? new Date(i.computed.closedOn) : null);
            return isClosed && closedDate && closedDate >= start && closedDate <= end;
        });

        // 1. Calculations
        const totalCount = createdInPeriod.length;
        
        // Find oldest ticket creation date in period
        let oldestDateStr = '';
        if (createdInPeriod.length > 0) {
            const sortedByCreated = [...createdInPeriod].sort((a, b) => new Date(a.created_on) - new Date(b.created_on));
            const oldestDate = new Date(sortedByCreated[0].created_on);
            oldestDateStr = oldestDate.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
        }
        
        // Open issues are those where status id is not closed (Closed status id is typically 5)
        const openIssues = issues.filter(issue => {
            const isClosed = isIssueClosed(issue);
            return !isClosed;
        });
        
        const openCount = openIssues.length;
        
        // Urgent tickets (priority "Alta", priority_id === 3)
        const urgentIssues = openIssues.filter(issue => issue.priority && (issue.priority.id === 3 || issue.priority.name.toLowerCase() === 'alta'));
        const urgentCount = urgentIssues.length;
        
        // Backlog/Overdue (> 2 days ago)
        const now = new Date();
        const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
        const overdueIssues = openIssues.filter(issue => new Date(issue.created_on) < twoDaysAgo);
        const overdueCount = overdueIssues.length;
        
        // --- 1. Timing & SLA KPI Calculations ---
        // MTTA calculation
        let totalMtta = 0;
        let mttaCount = 0;
        createdInPeriod.forEach(i => {
            if (i.computed && i.computed.mtta !== null) {
                totalMtta += i.computed.mtta;
                mttaCount++;
            }
        });
        const avgMtta = mttaCount > 0 ? totalMtta / mttaCount : 0;
        
        // Format MTTA
        let avgMttaStr = 'N/D';
        if (mttaCount > 0) {
            const mttaMin = Math.round(avgMtta / (60 * 1000));
            if (mttaMin < 60) {
                avgMttaStr = `${mttaMin} min`;
            } else if (mttaMin < 24 * 60) {
                avgMttaStr = `${(mttaMin / 60).toFixed(1)} ore`;
            } else {
                avgMttaStr = `${(mttaMin / (24 * 60)).toFixed(1)} gg`;
            }
        }
        
        // SLA Compliance calculation
        let slaCompliantCount = 0;
        let slaTotalCount = 0;
        
        createdInPeriod.forEach(i => {
            const limit = i.priority && (i.priority.id === 3 || i.priority.name.toLowerCase() === 'alta') 
                ? 4 * 60 * 60 * 1000 
                : 24 * 60 * 60 * 1000;
            
            const isClosed = isIssueClosed(i);
            
            if (isClosed) {
                const mttr = i.computed ? i.computed.mttr : null;
                if (mttr !== null) {
                    slaTotalCount++;
                    if (mttr <= limit) {
                        slaCompliantCount++;
                    }
                }
            } else {
                const age = now.getTime() - new Date(i.created_on).getTime();
                if (age > limit) {
                    slaTotalCount++;
                } else {
                    slaTotalCount++;
                    slaCompliantCount++;
                }
            }
        });
        
        const slaComplianceRate = slaTotalCount > 0 ? (slaCompliantCount / slaTotalCount) * 100 : 100;
        
        // MTTR calculation
        let totalMttr = 0;
        let mttrCount = 0;
        closedInPeriod.forEach(i => {
            if (i.computed && i.computed.mttr !== null) {
                totalMttr += i.computed.mttr;
                mttrCount++;
            }
        });
        const avgMttr = mttrCount > 0 ? totalMttr / mttrCount : 0;
        let avgMttrStr = 'N/D';
        if (mttrCount > 0) {
            const mttrHours = avgMttr / (60 * 60 * 1000);
            if (mttrHours < 24) {
                avgMttrStr = `${mttrHours.toFixed(1)} ore`;
            } else {
                avgMttrStr = `${(mttrHours / 24).toFixed(1)} gg`;
            }
        }
        
        // --- 2. Efficiency KPI Calculations ---
        let resolvedCount = 0;
        let fcrCount = 0;
        closedInPeriod.forEach(i => {
            const isClosed = isIssueClosed(i);
            if (isClosed) {
                resolvedCount++;
                if (i.computed && i.computed.isFCR) {
                    fcrCount++;
                }
            }
        });
        const fcrRate = resolvedCount > 0 ? (fcrCount / resolvedCount) * 100 : 0;
        
        let reopenedCount = 0;
        closedInPeriod.forEach(i => {
            if (i.computed && i.computed.isReopened) {
                reopenedCount++;
            }
        });
        const reopenRate = resolvedCount > 0 ? (reopenedCount / resolvedCount) * 100 : 0;
        
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        let createdLastWeek = 0;
        let closedLastWeek = 0;
        issues.forEach(i => {
            if (new Date(i.created_on) > oneWeekAgo) {
                createdLastWeek++;
            }
            if (i.computed && i.computed.closedOn && new Date(i.computed.closedOn) > oneWeekAgo) {
                closedLastWeek++;
            }
        });
        let backlogGrowthRate = 1.0;
        if (closedLastWeek > 0) {
            backlogGrowthRate = createdLastWeek / closedLastWeek;
        } else if (createdLastWeek > 0) {
            backlogGrowthRate = createdLastWeek;
        } else {
            backlogGrowthRate = 0.0;
        }
        
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const createdLastMonth = issues.filter(i => new Date(i.created_on) > thirtyDaysAgo).length;
        const dailyAverage = (createdLastMonth / 30).toFixed(1);
        
        // Render 4 counters
        const kpiTotal = document.getElementById('redmine-kpi-total');
        const kpiTotalSubtext = document.getElementById('redmine-kpi-total-subtext');
        const kpiOpen = document.getElementById('redmine-kpi-open');
        const kpiOpenSubtext = document.getElementById('redmine-kpi-open-subtext');
        const kpiUrgent = document.getElementById('redmine-kpi-urgent');
        const kpiOverdue = document.getElementById('redmine-kpi-overdue');
        const kpiOverdueSubtext = document.getElementById('redmine-kpi-overdue-subtext');

        if (kpiTotal) {
            kpiTotal.textContent = totalCount;
            kpiTotal.setAttribute('title', `Media ticket giornalieri (ultimi 30 giorni): ${dailyAverage}`);
            kpiTotal.style.cursor = 'help';
        }
        if (kpiTotalSubtext) {
            const closedCountStr = `Chiusi: ${closedInPeriod.length}`;
            if (oldestDateStr) {
                kpiTotalSubtext.textContent = `${closedCountStr} • Dal ${oldestDateStr}`;
            } else {
                kpiTotalSubtext.textContent = `${closedCountStr} • compresi i chiusi`;
            }
        }
        
        const urgentPct = openCount > 0 ? Math.round((urgentCount / openCount) * 100) : 0;
        const overduePct = openCount > 0 ? Math.round((overdueCount / openCount) * 100) : 0;

        if (kpiOpen) kpiOpen.textContent = openCount;
        if (kpiOpenSubtext) {
            const inElabIssues = openIssues.filter(issue => issue.status && (issue.status.id === 2 || issue.status.name.toLowerCase() === 'in elaborazione'));
            const inElabCount = inElabIssues.length;
            kpiOpenSubtext.textContent = `In elab.: ${inElabCount} • MTTA Medio: ${avgMttaStr}`;
        }
        if (kpiUrgent) kpiUrgent.textContent = `${urgentCount} (${urgentPct}%)`;
        if (kpiOverdue) kpiOverdue.textContent = `${overdueCount} (${overduePct}%)`;
        if (kpiOverdueSubtext) {
            kpiOverdueSubtext.textContent = `SLA Compliance: ${slaComplianceRate.toFixed(0)}%`;
        }
        
        // --- Render Focus Efficienza Mini-Cards ---
        const kpiMttr = document.getElementById('redmine-kpi-mttr');
        const kpiFcr = document.getElementById('redmine-kpi-fcr');
        const kpiReopen = document.getElementById('redmine-kpi-reopen');
        const kpiBacklogGrowth = document.getElementById('redmine-kpi-backlog-growth');
        
        if (kpiMttr) kpiMttr.textContent = avgMttrStr;
        if (kpiFcr) kpiFcr.textContent = `${fcrRate.toFixed(1)}%`;
        if (kpiReopen) kpiReopen.textContent = `${reopenRate.toFixed(1)}%`;
        
        if (kpiBacklogGrowth) {
            kpiBacklogGrowth.textContent = backlogGrowthRate.toFixed(2);
            const card = kpiBacklogGrowth.closest('.mini-metric-card');
            if (card) {
                if (backlogGrowthRate > 1.0) {
                    card.classList.add('error-state');
                    card.classList.remove('warning-state');
                } else if (backlogGrowthRate > 0.8) {
                    card.classList.add('warning-state');
                    card.classList.remove('error-state');
                } else {
                    card.classList.remove('error-state', 'warning-state');
                }
            }
        }
        
        // 2. Collate Urgent & Backlog lists (Union of urgent & overdue issues, unique by id)
        const criticalIssuesMap = new Map();
        urgentIssues.forEach(issue => criticalIssuesMap.set(issue.id, { issue, isUrgent: true, isOverdue: false }));
        overdueIssues.forEach(issue => {
            if (criticalIssuesMap.has(issue.id)) {
                criticalIssuesMap.get(issue.id).isOverdue = true;
            } else {
                criticalIssuesMap.set(issue.id, { issue, isUrgent: false, isOverdue: true });
            }
        });
        
        const criticalList = Array.from(criticalIssuesMap.values());
        criticalList.sort((a, b) => {
            if (a.isUrgent !== b.isUrgent) return b.isUrgent - a.isUrgent;
            return new Date(b.issue.created_on) - new Date(a.issue.created_on);
        });
        
        const criticalBadge = document.getElementById('critical-badge-count');
        if (criticalBadge) {
            if (criticalList.length > 0) {
                criticalBadge.textContent = criticalList.length;
                criticalBadge.classList.remove('d-none');
            } else {
                criticalBadge.classList.add('d-none');
            }
        }
        
        const tbody = document.getElementById('redmine-critical-table-body');
        if (tbody) {
            tbody.innerHTML = '';
            
            if (criticalList.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="5" class="text-center py-4 text-muted">
                            <i class="fa-solid fa-circle-check text-success me-2"></i> Nessun ticket critico rilevato. Ottimo lavoro!
                        </td>
                    </tr>
                `;
            } else {
                criticalList.forEach(({ issue, isUrgent, isOverdue }) => {
                    const tr = document.createElement('tr');
                    
                    const projClass = issue.project.id === 7312 ? 'project-lvl2' : 'project-lvl1';
                    const projName = issue.project.id === 7312 ? 'L2' : 'L1';
                    const projBadge = `<span class="redmine-project-badge ${projClass}" title="${DOMPurify.sanitize(issue.project.name)}">${projName}</span>`;
                    
                    let priorityText = issue.priority ? issue.priority.name : 'Normale';
                    let priorityBadge = '';
                    if (isUrgent) {
                        priorityBadge = `<span class="redmine-priority-badge priority-alta">${DOMPurify.sanitize(priorityText)}</span>`;
                    } else {
                        priorityBadge = `<span class="text-secondary small">${DOMPurify.sanitize(priorityText)}</span>`;
                    }
                    
                    let ageBadge = '';
                    const createdDate = new Date(issue.created_on);
                    const ageInDays = Math.floor((now.getTime() - createdDate.getTime()) / (24 * 60 * 60 * 1000));
                    
                    if (isOverdue) {
                        ageBadge = `<span class="redmine-age-badge age-arretrato" title="Creato il ${createdDate.toLocaleString()}">${ageInDays} gg</span>`;
                    } else {
                        ageBadge = `<span class="text-secondary small" title="Creato il ${createdDate.toLocaleString()}">${ageInDays} gg</span>`;
                    }

                    const notificationField = issue.custom_fields && issue.custom_fields.find(cf => cf.name === 'Stato notifica' || /Stato\s*notifica/i.test(cf.name));
                    const isNotified = notificationField && (notificationField.value === '1' || notificationField.value === 1);
                    
                    let notificationIcon = '';
                    if (isNotified) {
                        notificationIcon = `<i class="fa-solid fa-paper-plane notification-status-icon notified me-2" title="Notifica inviata: il mittente è a conoscenza del numero di ticket" style="cursor: help;"></i>`;
                    } else {
                        notificationIcon = `<i class="fa-solid fa-paper-plane notification-status-icon not-notified me-2" title="Notifica NON inviata: il mittente potrebbe NON conoscere il numero di ticket" style="cursor: help;"></i>`;
                    }
                    
                    tr.innerHTML = `
                        <td class="small fw-semibold text-secondary">#${issue.id}</td>
                        <td>${projBadge}</td>
                        <td>
                            <div class="d-flex align-items-center">
                                ${notificationIcon}
                                <a href="https://projects.maestrale.it/issues/${issue.id}" target="_blank" rel="noopener noreferrer" class="ticket-link">
                                    ${DOMPurify.sanitize(issue.subject)}
                                </a>
                            </div>
                        </td>
                        <td>${priorityBadge}</td>
                        <td>${ageBadge}</td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        }

        // --- Render Unassigned Tickets Table ---
        const unassignedTbody = document.getElementById('redmine-unassigned-table-body');
        const unassignedBadge = document.getElementById('redmine-unassigned-badge-count');
        
        if (unassignedTbody) {
            unassignedTbody.innerHTML = '';
            
            const unassignedOpenTickets = issues.filter(issue => {
                const isClosed = isIssueClosed(issue);
                const isUnassigned = issue.assigned_to && (issue.assigned_to.id === 1021 || issue.assigned_to.id === 1022);
                return !isClosed && isUnassigned;
            });

            unassignedOpenTickets.sort((a, b) => new Date(b.created_on) - new Date(a.created_on));

            if (unassignedBadge) {
                if (unassignedOpenTickets.length > 0) {
                    unassignedBadge.textContent = unassignedOpenTickets.length;
                    unassignedBadge.classList.remove('d-none');
                } else {
                    unassignedBadge.classList.add('d-none');
                }
            }

            if (unassignedOpenTickets.length === 0) {
                unassignedTbody.innerHTML = `
                    <tr>
                        <td colspan="5" class="text-center py-4 text-muted">
                            <i class="fa-solid fa-circle-check text-success me-2"></i> Nessun ticket non assegnato in coda. Ottimo!
                        </td>
                    </tr>
                `;
            } else {
                unassignedOpenTickets.forEach(issue => {
                    const tr = document.createElement('tr');
                    
                    const projClass = issue.project.id === 7312 ? 'project-lvl2' : 'project-lvl1';
                    const projName = issue.project.id === 7312 ? 'L2' : 'L1';
                    const projBadge = `<span class="redmine-project-badge ${projClass}" title="${DOMPurify.sanitize(issue.project.name)}">${projName}</span>`;
                    
                    const isUrgent = issue.priority && (issue.priority.id === 3 || issue.priority.name.toLowerCase() === 'alta');
                    let priorityText = issue.priority ? issue.priority.name : 'Normale';
                    let priorityBadge = '';
                    if (isUrgent) {
                        priorityBadge = `<span class="redmine-priority-badge priority-alta">${DOMPurify.sanitize(priorityText)}</span>`;
                    } else {
                        priorityBadge = `<span class="text-secondary small">${DOMPurify.sanitize(priorityText)}</span>`;
                    }
                    
                    const createdDate = new Date(issue.created_on);
                    const ageInDays = Math.floor((now.getTime() - createdDate.getTime()) / (24 * 60 * 60 * 1000));
                    
                    const isOverdue = ageInDays >= 2;
                    let ageBadge = '';
                    if (isOverdue) {
                        ageBadge = `<span class="redmine-age-badge age-arretrato" title="Creato il ${createdDate.toLocaleString()}">${ageInDays} gg</span>`;
                    } else {
                        ageBadge = `<span class="text-secondary small" title="Creato il ${createdDate.toLocaleString()}">${ageInDays} gg</span>`;
                    }

                    const notificationField = issue.custom_fields && issue.custom_fields.find(cf => cf.name === 'Stato notifica' || /Stato\s*notifica/i.test(cf.name));
                    const isNotified = notificationField && (notificationField.value === '1' || notificationField.value === 1);
                    
                    let notificationIcon = '';
                    if (isNotified) {
                        notificationIcon = `<i class="fa-solid fa-paper-plane notification-status-icon notified me-2" title="Notifica inviata: il mittente è a conoscenza del numero di ticket" style="cursor: help;"></i>`;
                    } else {
                        notificationIcon = `<i class="fa-solid fa-paper-plane notification-status-icon not-notified me-2" title="Notifica NON inviata: il mittente potrebbe NON conoscere il numero di ticket" style="cursor: help;"></i>`;
                    }
                    
                    tr.innerHTML = `
                        <td class="small fw-semibold text-secondary">#${issue.id}</td>
                        <td>${projBadge}</td>
                        <td>
                            <div class="d-flex align-items-center">
                                ${notificationIcon}
                                <a href="https://projects.maestrale.it/issues/${issue.id}" target="_blank" rel="noopener noreferrer" class="ticket-link">
                                    ${DOMPurify.sanitize(issue.subject)}
                                </a>
                            </div>
                        </td>
                        <td>${priorityBadge}</td>
                        <td>${ageBadge}</td>
                    `;
                    unassignedTbody.appendChild(tr);
                });
            }
        }

        // --- Render User Workload Table ---
        const workloadTbody = document.getElementById('redmine-user-workload-table-body');
        if (workloadTbody) {
            workloadTbody.innerHTML = '';

            const userOpenTickets = issues.filter(issue => {
                const isClosed = isIssueClosed(issue);
                const isSpecificUser = issue.assigned_to && issue.assigned_to.id !== 1021 && issue.assigned_to.id !== 1022;
                return !isClosed && isSpecificUser;
            });

            const userWorkloadMap = {};
            userOpenTickets.forEach(issue => {
                const userId = issue.assigned_to.id;
                const userName = issue.assigned_to.name;
                if (!userWorkloadMap[userId]) {
                    userWorkloadMap[userId] = {
                        userId: userId,
                        userName: userName,
                        ticketCount: 0,
                        oldestTicketDate: null,
                        overdueCount: 0,
                        highPriorityCount: 0
                    };
                }
                const userObj = userWorkloadMap[userId];
                userObj.ticketCount++;
                
                const createdDate = new Date(issue.created_on);
                if (!userObj.oldestTicketDate || createdDate < new Date(userObj.oldestTicketDate)) {
                    userObj.oldestTicketDate = issue.created_on;
                }
                
                const ageInMs = now.getTime() - createdDate.getTime();
                if (ageInMs > 2 * 24 * 60 * 60 * 1000) {
                    userObj.overdueCount++;
                }
                
                if (issue.priority && (issue.priority.id === 3 || issue.priority.name.toLowerCase() === 'alta')) {
                    userObj.highPriorityCount++;
                }
            });

            const sortedUsers = Object.values(userWorkloadMap).sort((a, b) => {
                // 1. numero ticket (decrescente)
                if (b.ticketCount !== a.ticketCount) {
                    return b.ticketCount - a.ticketCount;
                }
                // 2. data apertura ticket più vecchio (crescente)
                const timeA = new Date(a.oldestTicketDate).getTime();
                const timeB = new Date(b.oldestTicketDate).getTime();
                if (timeA !== timeB) {
                    return timeA - timeB;
                }
                // 3. numero ticket in ritardo (decrescente)
                if (b.overdueCount !== a.overdueCount) {
                    return b.overdueCount - a.overdueCount;
                }
                // 4. numero ticket con priorità alta (decrescente)
                if (b.highPriorityCount !== a.highPriorityCount) {
                    return b.highPriorityCount - a.highPriorityCount;
                }
                return a.userName.localeCompare(b.userName);
            });

            if (sortedUsers.length === 0) {
                workloadTbody.innerHTML = `
                    <tr>
                        <td colspan="2" class="text-center py-4 text-muted">
                            <i class="fa-solid fa-circle-check text-success me-2"></i> Nessun ticket assegnato agli utenti.
                        </td>
                    </tr>
                `;
            } else {
                sortedUsers.forEach(user => {
                    const tr = document.createElement('tr');
                    
                    const oldestDate = new Date(user.oldestTicketDate);
                    const oldestDateStr = oldestDate.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
                    const ageInDays = Math.floor((now.getTime() - oldestDate.getTime()) / (24 * 60 * 60 * 1000));
                    
                    const tooltipText = `Carico di ${user.userName}:
• Ticket totali: ${user.ticketCount}
• Ticket più vecchio: ${oldestDateStr} (${ageInDays} giorni fa)
• In ritardo (+2gg): ${user.overdueCount}
• Priorità alta: ${user.highPriorityCount}`;

                    tr.innerHTML = `
                        <td>
                            <div class="fw-semibold" style="cursor: help;" title="${DOMPurify.sanitize(tooltipText)}">
                                <i class="fa-solid fa-user text-secondary me-2"></i>${DOMPurify.sanitize(user.userName)}
                            </div>
                        </td>
                        <td class="text-center">
                            <span class="badge bg-secondary px-2.5 py-1.5 rounded" style="font-size: 0.85rem; cursor: help;" title="${DOMPurify.sanitize(tooltipText)}">
                                ${user.ticketCount}
                            </span>
                        </td>
                    `;
                    workloadTbody.appendChild(tr);
                });
            }
        }
        
        // 3. Render Charts and Lists
        renderRedmineDashboardChart(issues, start, end);
        renderRedmineDistributionCharts(createdInPeriod);
        renderRedmineCategoryStats(openIssues, urgentIssues, overdueIssues, closedInPeriod);
    }

    function renderRedmineDistributionCharts(issues) {
        currentIssuesForHeatmap = issues;
        // --- 1. Doughnut Chart: Component Distribution ---
        const catMap = {};
        issues.forEach(i => {
            if (i.computed && i.computed.serviceType) {
                const cat = i.computed.serviceType;
                catMap[cat] = (catMap[cat] || 0) + 1;
            } else {
                catMap["Altro / Generico"] = (catMap["Altro / Generico"] || 0) + 1;
            }
        });
        
        const sortedCats = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
        const finalCats = [];
        const finalCounts = [];
        let otherSum = 0;
        
        sortedCats.forEach((entry, idx) => {
            if (idx < 5) {
                finalCats.push(entry[0]);
                finalCounts.push(entry[1]);
            } else {
                otherSum += entry[1];
            }
        });
        if (otherSum > 0) {
            finalCats.push("Altro");
            finalCounts.push(otherSum);
        }
        
        const distCanvas = document.getElementById('redmine-distribution-chart');
        if (distCanvas) {
            if (redmineDistributionChartInstance) {
                redmineDistributionChartInstance.destroy();
            }
            
            const isDarkMode = document.body.classList.contains('dark-mode');
            const textColor = isDarkMode ? '#9ca3af' : '#4b5563';
            
            const ctx = distCanvas.getContext('2d');
            redmineDistributionChartInstance = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: finalCats,
                    datasets: [{
                        data: finalCounts,
                        backgroundColor: [
                            '#3b82f6', 
                            '#10b981', 
                            '#f59e0b', 
                            '#ef4444', 
                            '#8b5cf6', 
                            '#6b7280'  
                        ],
                        borderWidth: isDarkMode ? 2 : 1,
                        borderColor: isDarkMode ? '#1e2530' : '#ffffff'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: textColor,
                                font: { family: 'Poppins', size: 9 },
                                boxWidth: 8,
                                usePointStyle: true
                            }
                        }
                    }
                }
            });
        }
        
        // --- 2. Bar Chart: Hourly Distribution (Heatmap) ---
        const hourlyCounts = Array(24).fill(0);
        issues.forEach(i => {
            const date = new Date(i.created_on);
            const hour = date.getHours();
            hourlyCounts[hour]++;
        });
        
        const hourlyLabels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
        
        const heatmapCanvas = document.getElementById('redmine-heatmap-chart');
        if (heatmapCanvas) {
            if (redmineHeatmapChartInstance) {
                redmineHeatmapChartInstance.destroy();
            }
            
            const isDarkMode = document.body.classList.contains('dark-mode');
            const textColor = isDarkMode ? '#9ca3af' : '#4b5563';
            const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
            
            const gaussianData = calculateGaussianCurve(hourlyCounts);
            
            const ctx = heatmapCanvas.getContext('2d');
            redmineHeatmapChartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: hourlyLabels,
                    datasets: [
                        {
                            type: 'line',
                            label: 'Curva Gaussiana',
                            data: gaussianData,
                            borderColor: '#ef4444',
                            borderWidth: 2,
                            pointRadius: 0,
                            pointHoverRadius: 0,
                            fill: false,
                            tension: 0.4
                        },
                        {
                            type: 'bar',
                            label: 'Ticket Aperti',
                            data: hourlyCounts,
                            backgroundColor: 'rgba(245, 158, 11, 0.7)',
                            borderColor: '#f59e0b',
                            borderWidth: 1,
                            borderRadius: 4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        x: {
                            grid: { display: false },
                            ticks: {
                                color: textColor,
                                font: { family: 'Poppins', size: 8 }
                            }
                        },
                        y: {
                            grid: { color: gridColor },
                            ticks: {
                                color: textColor,
                                font: { family: 'Poppins', size: 9 },
                                precision: 0
                            },
                            beginAtZero: true
                        }
                    },
                    onClick: (event, elements) => {
                        if (elements && elements.length > 0) {
                            const index = elements[0].index;
                            openHeatmapFullscreen(index);
                        }
                    }
                }
            });
        }
        
        // --- 3. Top 5 Host Critici List ---
        const hostMap = {};
        issues.forEach(i => {
            if (i.computed && i.computed.host) {
                const host = i.computed.host;
                hostMap[host] = (hostMap[host] || 0) + 1;
            }
        });
        
        const sortedHosts = Object.entries(hostMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        
        const hostsContainer = document.getElementById('redmine-top-hosts-container');
        if (hostsContainer) {
            hostsContainer.innerHTML = '';
            
            if (sortedHosts.length === 0) {
                hostsContainer.innerHTML = `<div class="text-center py-5 text-muted small"><i class="fa-solid fa-circle-check text-success me-2"></i>Nessun host critico rilevato (nessun ticket Checkmk).</div>`;
            } else {
                const maxCount = sortedHosts[0][1];
                sortedHosts.forEach(entry => {
                    const hostName = entry[0];
                    const count = entry[1];
                    const percent = Math.max(10, Math.round((count / maxCount) * 100));
                    
                    const div = document.createElement('div');
                    div.className = 'mb-3';
                    div.innerHTML = `
                        <div class="d-flex justify-content-between mb-1">
                            <span class="fw-semibold text-secondary text-truncate" style="max-width: 75%;" title="${DOMPurify.sanitize(hostName)}">${DOMPurify.sanitize(hostName)}</span>
                            <span class="text-secondary small fw-bold">${count} ticket</span>
                        </div>
                        <div class="progress" style="height: 6px; background-color: var(--panel-border);">
                            <div class="progress-bar bg-warning" role="progressbar" style="width: ${percent}%; border-radius: 3px;"></div>
                        </div>
                    `;
                    hostsContainer.appendChild(div);
                });
            }
        }
    }

    function renderRedmineDashboardChart(issues, start, end) {
        const canvas = document.getElementById('redmine-chart');
        if (!canvas) return;
        
        // Destroy existing chart to avoid overlay glitch
        if (redmineChartInstance) {
            redmineChartInstance.destroy();
        }
        
        // Get date ranges based on start and end
        const startDate = new Date(start.getTime());
        startDate.setHours(0, 0, 0, 0);
        
        const diffTime = Math.abs(end - start);
        const daysToGenerate = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        // Generate daily label keys YYYY-MM-DD and formatting for display
        const dateLabels = [];
        const dateKeys = [];
        for (let i = 0; i < daysToGenerate; i++) {
            const d = new Date(startDate.getTime());
            d.setDate(startDate.getDate() + i);
            
            // Key YYYY-MM-DD
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const key = `${year}-${month}-${day}`;
            dateKeys.push(key);
            
            // Label
            let label = '';
            if (daysToGenerate <= 7) {
                label = d.toLocaleDateString('it-IT', { weekday: 'short' });
            } else if (daysToGenerate <= 90) {
                label = d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
            } else {
                label = d.toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
            }
            
            if (daysToGenerate > 90 && dateLabels.includes(label)) {
                dateLabels.push('');
            } else {
                dateLabels.push(label);
            }
        }
        
        // Group ticket open/close events by date key
        const openCounts = {};
        const closedCounts = {};
        dateKeys.forEach(k => {
            openCounts[k] = 0;
            closedCounts[k] = 0;
        });
        
        issues.forEach(issue => {
            if (issue.created_on) {
                const createdDate = new Date(issue.created_on);
                const year = createdDate.getFullYear();
                const month = String(createdDate.getMonth() + 1).padStart(2, '0');
                const day = String(createdDate.getDate()).padStart(2, '0');
                const key = `${year}-${month}-${day}`;
                if (key in openCounts) {
                    openCounts[key]++;
                }
            }
            
            const isClosed = isIssueClosed(issue);
            if (isClosed && issue.closed_on) {
                const closedDate = new Date(issue.closed_on);
                const year = closedDate.getFullYear();
                const month = String(closedDate.getMonth() + 1).padStart(2, '0');
                const day = String(closedDate.getDate()).padStart(2, '0');
                const key = `${year}-${month}-${day}`;
                if (key in closedCounts) {
                    closedCounts[key]++;
                }
            }
        });
        
        const openData = dateKeys.map(k => openCounts[k]);
        const closedData = dateKeys.map(k => closedCounts[k]);
        
        if (typeof Chart === 'undefined') {
            console.error('Chart.js library is not loaded!');
            return;
        }
        
        const isDarkMode = document.body.classList.contains('dark-mode');
        const textColor = isDarkMode ? '#9ca3af' : '#4b5563';
        const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
        
        const ctx = canvas.getContext('2d');
        redmineChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: dateLabels,
                datasets: [
                    {
                        label: 'Aperti (Creati)',
                        data: openData,
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        borderWidth: 3,
                        pointBackgroundColor: '#ef4444',
                        pointBorderColor: isDarkMode ? '#171d26' : '#ffffff',
                        pointHoverRadius: 6,
                        tension: 0.35,
                        fill: true
                    },
                    {
                        label: 'Chiusi (Risolti)',
                        data: closedData,
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        borderWidth: 3,
                        pointBackgroundColor: '#10b981',
                        pointBorderColor: isDarkMode ? '#171d26' : '#ffffff',
                        pointHoverRadius: 6,
                        tension: 0.35,
                        fill: true
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            color: textColor,
                            font: {
                                family: 'Poppins',
                                size: 11,
                                weight: '500'
                            },
                            boxWidth: 12,
                            usePointStyle: true,
                            pointStyle: 'circle'
                        }
                    },
                    tooltip: {
                        backgroundColor: isDarkMode ? '#171d26' : '#ffffff',
                        titleColor: isDarkMode ? '#ffffff' : '#111111',
                        bodyColor: isDarkMode ? '#f3f4f6' : '#333333',
                        borderColor: isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
                        borderWidth: 1,
                        padding: 10,
                        bodyFont: {
                            family: 'Poppins'
                        },
                        titleFont: {
                            family: 'Poppins',
                            weight: '600'
                        },
                        callbacks: {
                            title: function(context) {
                                const index = context[0].dataIndex;
                                const originalKey = dateKeys[index];
                                const parts = originalKey.split('-');
                                return `${parts[2]}/${parts[1]}/${parts[0]}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            display: false
                        },
                        ticks: {
                            color: textColor,
                            font: {
                                family: 'Poppins',
                                size: 10
                            }
                        }
                    },
                    y: {
                        grid: {
                            color: gridColor
                        },
                        ticks: {
                            color: textColor,
                            precision: 0,
                            font: {
                                family: 'Poppins',
                                size: 10
                            }
                        },
                        beginAtZero: true
                    }
                }
            }
        });
    }

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

    // --- Knowledge Base Sync Logic ---
    const syncKbBtn = document.getElementById('sync-kb-btn');
    const syncKbStatus = document.getElementById('sync-kb-status');
    
    if (syncKbBtn) {
        syncKbBtn.addEventListener('click', async () => {
            syncKbBtn.disabled = true;
            syncKbBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sincronizzazione...';
            if (syncKbStatus) {
                syncKbStatus.style.display = 'block';
                syncKbStatus.style.color = 'var(--text-light-color)';
                syncKbStatus.textContent = 'Avvio caricamento ticket Redmine in SQLite (può richiedere fino a un minuto)...';
            }
            try {
                const response = await fetch('/api/smartsupport/sync-historic-tickets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ limit: 100 })
                });
                
                const data = await response.json();
                if (response.ok && data.success) {
                    syncKbBtn.innerHTML = '<i class="fa-solid fa-check text-success"></i> Completato';
                    if (syncKbStatus) {
                        syncKbStatus.style.color = '#198754';
                        syncKbStatus.textContent = `Sincronizzazione completata! Indicizzati ${data.indexedCount} ticket con successo (${data.errorCount} errori).`;
                    }
                } else {
                    throw new Error(data.error || 'Errore sconosciuto');
                }
            } catch (err) {
                console.error(err);
                syncKbBtn.disabled = false;
                syncKbBtn.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-danger"></i> Riprova';
                if (syncKbStatus) {
                    syncKbStatus.style.color = '#dc3545';
                    syncKbStatus.textContent = `Errore di sincronizzazione: ${err.message}`;
                }
            }
        });
    }

    const aiutoBtn = document.getElementById('aiuto-button');
    if (aiutoBtn) aiutoBtn.style.display = 'none';


    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            const activeTab = document.querySelector('.nav-link.active')?.id;
            
            // Find all emails belonging to this tab
            let tabEmails = [];
            if (activeTab === 'human-tab') {
                tabEmails = allEmails.filter(e => (!e.from || !e.from.includes('Cloud Monitor')) && e.category === 'Human');
            } else if (activeTab === 'bot-tab') {
                tabEmails = allEmails.filter(e => (!e.from || !e.from.includes('Cloud Monitor')) && e.category === 'Bot');
            } else if (activeTab === 'cloud-monitor-tab') {
                const selectedHours = parseInt(document.getElementById('cloud-hours-select')?.value || '24', 10);
                const threshold = Date.now() - (selectedHours * 60 * 60 * 1000);
                tabEmails = cloudMonitorIssues.filter(issue => {
                    const issueDate = new Date(issue.created_on).getTime();
                    return issueDate >= threshold;
                }).map(issue => ({ id: issue.id })); // Mapped to have .id
            } else if (activeTab === 'read-emails-tab') {
                tabEmails = readEmails;
            } else if (activeTab === 'show-pinned-emails') {
                tabEmails = pinnedEmails;
            }

            // Add or remove IDs of all emails in the active tab to selectedEmailIds
            tabEmails.forEach(email => {
                if (isChecked) selectedEmailIds.add(email.id);
                else selectedEmailIds.delete(email.id);
            });

            // Visually check/uncheck the visible checkboxes in the DOM for this tab
            let viewId;
            if (activeTab === 'human-tab') viewId = 'human-view';
            else if (activeTab === 'bot-tab') viewId = 'bot-view';
            else if (activeTab === 'cloud-monitor-tab') viewId = 'cloud-monitor-view';
            else if (activeTab === 'read-emails-tab') viewId = 'read-emails-view';
            else if (activeTab === 'show-pinned-emails') viewId = 'pinned-view';

            if (viewId) {
                const view = document.getElementById(viewId);
                const allCheckboxes = view.querySelectorAll('.email-item input[type="checkbox"], .pair-box input[type="checkbox"]');
                allCheckboxes.forEach(checkbox => {
                    checkbox.checked = isChecked;
                    const changeEvent = new Event('change');
                    checkbox.dispatchEvent(changeEvent);
                });
            }
        });
    }

    if (selectFilteredCheckbox) {
        selectFilteredCheckbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            const activeTab = document.querySelector('.nav-link.active')?.id;
            let viewId;
            if (activeTab === 'human-tab') {
                viewId = 'human-view';
            } else if (activeTab === 'bot-tab') {
                viewId = 'bot-view';
            } else if (activeTab === 'cloud-monitor-tab') {
                viewId = 'cloud-monitor-view';
            } else if (activeTab === 'read-emails-tab') {
                viewId = 'read-emails-view';
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
                    const changeEvent = new Event('change');
                    checkbox.dispatchEvent(changeEvent);
                });
            }
        });
    }

    const emailSearchInput = document.getElementById('email-search-input');
    emailSearchInput.addEventListener('input', () => {
        const activeTab = document.querySelector('.nav-link.active')?.id;
        if (activeTab === 'read-emails-tab') {
            rerenderReadEmails();
        } else {
            rerenderEmails();
        }
    });

    // Toolbar Mobile Toggle
    const toolbarToggleBtn = document.getElementById('toolbar-toggle-btn');
    const toolbarContent = document.getElementById('toolbar-content');
    if (toolbarToggleBtn && toolbarContent) {
        toolbarToggleBtn.addEventListener('click', () => {
            toolbarContent.classList.toggle('open');
            const isOpen = toolbarContent.classList.contains('open');
            toolbarToggleBtn.innerHTML = isOpen ? '<i class="fa-solid fa-times"></i>' : '<i class="fa-solid fa-filter"></i>';
            toolbarToggleBtn.classList.toggle('btn-primary', isOpen);
            toolbarToggleBtn.classList.toggle('btn-outline-secondary', !isOpen);
        });
    }

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

    if (sortSelect) {
        sortSelect.value = currentSortMode;
        sortSelect.addEventListener('change', (e) => {
            currentSortMode = e.target.value;
            applySorting();
            const activeTab = document.querySelector('.nav-link.active')?.id;
            if (activeTab === 'read-emails-tab') {
                rerenderReadEmails();
            } else {
                rerenderEmails();
            }
        });
    }

    const sortDirectionBtn = document.getElementById('sort-direction-btn');
    const sortDirectionIcon = document.getElementById('sort-direction-icon');
    if (sortDirectionBtn && sortDirectionIcon) {
        sortDirectionBtn.addEventListener('click', () => {
            if (currentSortDirection === 'desc') {
                currentSortDirection = 'asc';
                sortDirectionIcon.className = 'fa-solid fa-arrow-up-wide-short';
                sortDirectionBtn.title = 'Ordinamento Crescente';
            } else {
                currentSortDirection = 'desc';
                sortDirectionIcon.className = 'fa-solid fa-arrow-down-wide-short';
                sortDirectionBtn.title = 'Ordinamento Decrescente';
            }
            applySorting();
            const activeTab = document.querySelector('.nav-link.active')?.id;
            if (activeTab === 'read-emails-tab') {
                rerenderReadEmails();
            } else {
                rerenderEmails();
            }
        });
    }

    function applySorting() {
        const isDesc = currentSortDirection === 'desc';
        if (currentSortMode === 'score') {
            allEmails.sort((a, b) => isDesc ? b.score - a.score : a.score - b.score);
            readEmails.sort((a, b) => isDesc ? b.score - a.score : a.score - b.score);
        } else {
            allEmails.sort((a, b) => {
                const dateA = parseInt(a.internalDate, 10) || 0;
                const dateB = parseInt(b.internalDate, 10) || 0;
                return isDesc ? dateB - dateA : dateA - dateB;
            });
            readEmails.sort((a, b) => {
                const dateA = parseInt(a.internalDate, 10) || 0;
                const dateB = parseInt(b.internalDate, 10) || 0;
                return isDesc ? dateB - dateA : dateA - dateB;
            });
        }
    }

    function updateSortUI() {
        if (sortSelect) {
            sortSelect.value = currentSortMode;
        }
    }

    // Imposta lo stato iniziale della UI di sorting
    updateSortUI();



    async function handleMarkAction(action) {
        const selectedCheckboxes = document.querySelectorAll('.email-item input[type="checkbox"]:checked');
        let emailIds = Array.from(selectedCheckboxes).map(cb => cb.closest('.email-item').dataset.id);

        if (selectedEmailIds.size > emailIds.length) {
            emailIds = Array.from(selectedEmailIds);
        }

        if (emailIds.length === 0) {
            alert(`Seleziona almeno un'email.`);
            return;
        }

        const relatedIds = [];
        if (action === 'read') {
            emailIds.forEach(id => {
                const email = allEmails.find(e => e.id === id);
                if (email) {
                    const threadId = email.threadId;
                    const subject = email.subject;
                    allEmails.forEach(e => {
                        if ((threadId && e.threadId === threadId) || (!threadId && subject && e.subject === subject) || e.id === id) {
                            if (!relatedIds.includes(e.id)) {
                                relatedIds.push(e.id);
                            }
                        }
                    });
                } else {
                    if (!relatedIds.includes(id)) {
                        relatedIds.push(id);
                    }
                }
            });
        } else if (action === 'unread') {
            emailIds.forEach(id => {
                const email = readEmails.find(e => e.id === id);
                if (email) {
                    const threadId = email.threadId;
                    const subject = email.subject;
                    readEmails.forEach(e => {
                        if ((threadId && e.threadId === threadId) || (!threadId && subject && e.subject === subject) || e.id === id) {
                            if (!relatedIds.includes(e.id)) {
                                relatedIds.push(e.id);
                            }
                        }
                    });
                } else {
                    if (!relatedIds.includes(id)) {
                        relatedIds.push(id);
                    }
                }
            });
        }

        let endpoint, body;

        switch (action) {
            case 'read':
                endpoint = '/api/mark-as-read';
                body = { emailIds: relatedIds };
                break;
            case 'unread':
                endpoint = '/api/mark-as-unread';
                body = { emailIds: relatedIds };
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
            
            if (action === 'read') {
                // Add to readEmailIds Set
                relatedIds.forEach(id => readEmailIds.add(id));

                // Remove from pinned_email_ids in localStorage
                let savedPinnedIds = [];
                try {
                    savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
                } catch (e) {}
                savedPinnedIds = savedPinnedIds.filter(id => !relatedIds.includes(id));
                localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));

                // Add to explicitly_unpinned_email_ids in localStorage
                let unpinnedIds = [];
                try {
                    unpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
                } catch (e) {}
                relatedIds.forEach(id => {
                    if (!unpinnedIds.includes(id)) {
                        unpinnedIds.push(id);
                    }
                });
                localStorage.setItem('explicitly_unpinned_email_ids', JSON.stringify(unpinnedIds));

                // Instant visual feedback
                allEmails = allEmails.filter(e => !relatedIds.includes(e.id));
                rerenderEmails();

                // Clear selection
                selectedEmailIds.clear();
                if (selectAllCheckbox) selectAllCheckbox.checked = false;
                if (selectFilteredCheckbox) selectFilteredCheckbox.checked = false;

                // Sync in background
                fetchAndDisplayEmails(true);
            } else if (action === 'unread') {
                // Remove from readEmailIds Set so it appears back in the unread list
                relatedIds.forEach(id => readEmailIds.delete(id));

                // Instant visual feedback: remove from readEmails
                readEmails = readEmails.filter(e => !relatedIds.includes(e.id));
                rerenderReadEmails();

                // Clear selection
                selectedEmailIds.clear();
                if (selectAllCheckbox) selectAllCheckbox.checked = false;
                if (selectFilteredCheckbox) selectFilteredCheckbox.checked = false;

                // Sync unread emails in background
                fetchAndDisplayEmails(true);
            }
        } catch (error) {
            console.error(`Error marking emails as ${action}:`, error);
            alert(`Errore durante l'operazione. Controlla la console.`);
        } finally {
            loadingSpinner.style.display = 'none';
        }
    }

    function markVisualAsRead(emailIdOrIds) {
        const ids = Array.isArray(emailIdOrIds) ? emailIdOrIds : [emailIdOrIds];
        ids.forEach(id => {
            document.querySelectorAll(`[data-id="${id}"]`).forEach(el => {
                el.classList.add('marking-as-read');
            });
        });
    }

    function unmarkVisualAsRead(emailIdOrIds) {
        const ids = Array.isArray(emailIdOrIds) ? emailIdOrIds : [emailIdOrIds];
        ids.forEach(id => {
            document.querySelectorAll(`[data-id="${id}"]`).forEach(el => {
                el.classList.remove('marking-as-read');
            });
        });
    }

    async function markSingleEmailAsRead(emailId, emailItemElement) {
        const email = allEmails.find(e => e.id === emailId);
        const relatedEmails = [];
        if (email) {
            const threadId = email.threadId;
            const subject = email.subject;
            allEmails.forEach(e => {
                if ((threadId && e.threadId === threadId) || (!threadId && subject && e.subject === subject) || e.id === emailId) {
                    relatedEmails.push(e);
                }
            });
        } else {
            relatedEmails.push({ id: emailId });
        }

        const relatedIds = relatedEmails.map(e => e.id);
        markVisualAsRead(relatedIds);

        loadingSpinner.style.display = 'block';
        try {
            let success = false;
            let response;
            for (let i = 0; i < 3; i++) {
                response = await fetch('/api/mark-as-read', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emailIds: relatedIds })
                });

                if (response.ok) {
                    success = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (!success) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            
            // Clean up pin states in localStorage for this email and other emails in the same thread
            // Add all related IDs to local readEmailIds Set
            relatedIds.forEach(id => readEmailIds.add(id));

            // Remove from pinned_email_ids in localStorage
            let savedPinnedIds = [];
            try {
                savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
            } catch (e) {}
            savedPinnedIds = savedPinnedIds.filter(id => !relatedIds.includes(id));
            localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));

            // Add to explicitly_unpinned_email_ids in localStorage
            let unpinnedIds = [];
            try {
                unpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
            } catch (e) {}
            relatedIds.forEach(id => {
                if (!unpinnedIds.includes(id)) {
                    unpinnedIds.push(id);
                }
            });
            localStorage.setItem('explicitly_unpinned_email_ids', JSON.stringify(unpinnedIds));

            // Instant visual feedback: filter allEmails and rerender immediately
            allEmails = allEmails.filter(e => !relatedIds.includes(e.id));
            rerenderEmails();

            // Sincronizza in background
            fetchAndDisplayEmails(true);

        } catch (error) {
            console.error('Error marking email as read:', error);
            alert(`Errore durante l'operazione. Controlla la console.`);
            unmarkVisualAsRead(relatedIds);
        } finally {
            loadingSpinner.style.display = 'none';
        }
    }

    async function markSingleEmailAsUnread(emailId, emailItemElement) {
        if (emailItemElement) {
            emailItemElement.classList.add('marking-as-read');
        }

        // Clean up related read emails
        const email = readEmails.find(e => e.id === emailId);
        const relatedEmails = [];
        if (email) {
            const threadId = email.threadId;
            const subject = email.subject;
            readEmails.forEach(e => {
                if ((threadId && e.threadId === threadId) || (!threadId && subject && e.subject === subject) || e.id === emailId) {
                    relatedEmails.push(e);
                }
            });
        } else {
            relatedEmails.push({ id: emailId });
        }

        const relatedIds = relatedEmails.map(e => e.id);

        loadingSpinner.style.display = 'block';
        try {
            let success = false;
            let response;
            for (let i = 0; i < 3; i++) {
                response = await fetch('/api/mark-as-unread', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emailIds: relatedIds })
                });

                if (response.ok) {
                    success = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (!success) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();

            // Remove from readEmailIds Set so it appears back in the unread list
            relatedIds.forEach(id => readEmailIds.delete(id));

            // Instant visual feedback: remove from readEmails
            readEmails = readEmails.filter(e => !relatedIds.includes(e.id));
            rerenderReadEmails();

            // Sync unread emails in background
            fetchAndDisplayEmails(true);

        } catch (error) {
            console.error('Error marking email as unread:', error);
            alert(`Errore durante l'operazione. Controlla la console.`);
            if (emailItemElement) {
                emailItemElement.classList.remove('marking-as-read');
            }
        } finally {
            loadingSpinner.style.display = 'none';
        }
    }

    async function markMultipleEmailsAsReadDirectly(emailIds) {
        if (!emailIds || emailIds.length === 0) return;
        
        const relatedIds = [];
        emailIds.forEach(id => {
            const email = allEmails.find(e => e.id === id);
            if (email) {
                const threadId = email.threadId;
                const subject = email.subject;
                allEmails.forEach(e => {
                    if ((threadId && e.threadId === threadId) || (!threadId && subject && e.subject === subject) || e.id === id) {
                        if (!relatedIds.includes(e.id)) {
                            relatedIds.push(e.id);
                        }
                    }
                });
            } else {
                if (!relatedIds.includes(id)) {
                    relatedIds.push(id);
                }
            }
        });

        markVisualAsRead(relatedIds);
        
        loadingSpinner.style.display = 'block';
        try {
            let success = false;
            let response;
            for (let i = 0; i < 3; i++) {
                response = await fetch('/api/mark-as-read', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emailIds: relatedIds })
                });

                if (response.ok) {
                    success = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (!success) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();

            // Add all related IDs to local readEmailIds Set
            relatedIds.forEach(id => readEmailIds.add(id));

            // Remove from pinned_email_ids in localStorage
            let savedPinnedIds = [];
            try {
                savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
            } catch (e) {}
            savedPinnedIds = savedPinnedIds.filter(id => !relatedIds.includes(id));
            localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));

            // Add to explicitly_unpinned_email_ids in localStorage
            let unpinnedIds = [];
            try {
                unpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
            } catch (e) {}
            relatedIds.forEach(id => {
                if (!unpinnedIds.includes(id)) {
                    unpinnedIds.push(id);
                }
            });
            localStorage.setItem('explicitly_unpinned_email_ids', JSON.stringify(unpinnedIds));

            // Instant visual feedback: filter allEmails and rerender immediately
            allEmails = allEmails.filter(e => !relatedIds.includes(e.id));
            rerenderEmails();

            // Sincronizza in background
            fetchAndDisplayEmails(true);

        } catch (error) {
            console.error('Error marking emails as read:', error);
            alert(`Errore durante l'operazione. Controlla la console.`);
            unmarkVisualAsRead(relatedIds);
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
        // Save all spaces for background polling
        allChatSpaces = spaces || [];

        // Start background poll of all spaces every 30 seconds
        if (chatBackgroundPollTimer) clearInterval(chatBackgroundPollTimer);
        if (allChatSpaces.length > 0) {
            chatBackgroundPollTimer = setInterval(() => {
                pollAllChatSpacesInBackground(false);
            }, 30000);
            // Initial poll: only seed known message IDs (no notifications for existing messages)
            setTimeout(() => pollAllChatSpacesInBackground(true), 2000);
        }

        const container = document.getElementById('chat-spaces-list');
        container.innerHTML = '';

        if (spaces.length === 0) {
            container.innerHTML = '<p class="text-center p-3 text-muted">Nessuna conversazione trovata.</p>';
            return;
        }

        spaces.forEach(space => {
            const div = document.createElement('div');
            const spaceId = space.name.split('/')[1];
            div.className = `chat-space-item ${activeSpaceId === spaceId ? 'active' : ''}`;
            div.setAttribute('data-space-id', spaceId);

            // Per i DM spesso il nome è 'directMessage'
            const displayName = space.displayName || 'Direct Message';
            const unreadCount = unreadCountsBySpace[spaceId] || 0;

            div.innerHTML = `
                <div class="chat-space-icon"><i class="fa-solid fa-user"></i></div>
                <div class="chat-space-name">${DOMPurify.sanitize(displayName)}</div>
                <div class="chat-space-unread-dot" id="chat-unread-dot-${spaceId}" style="display: ${unreadCount > 0 ? 'block' : 'none'};"></div>
            `;

            div.addEventListener('click', () => {
                selectChatSpace(spaceId, displayName);
            });

            container.appendChild(div);
        });

        if (pendingSelectSpaceId) {
            const spaceId = pendingSelectSpaceId;
            pendingSelectSpaceId = null;
            const space = spaces.find(s => s.name.endsWith('/' + spaceId));
            if (space) {
                selectChatSpace(spaceId, space.displayName || 'Direct Message');
            }
        }
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

            const senderName = msg.sender?.displayName || membersMap[senderUserId] || (msg.sender?.type === 'BOT' ? 'Bot' : 'Unknown');
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
                    showChatNotification(senderName, notifText, activeSpaceId);
                    showBrowserPushNotification(senderName, notifText, activeSpaceId);
                }
            }
        });

        // Update badge if chat panel is not visible
        if (hasNewMessages) {
            const chatPanelEl = document.getElementById('chat-panel');
            if (chatPanelEl && chatPanelEl.style.display !== 'flex') {
                updateChatBadge(true);
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

    async function evaluateImportanceWithGemini(silent = false) {
        const apiKey = document.getElementById('gemini-api-key').value;
        if (!apiKey) {
            if (!silent) {
                alert("La Gemini API Key non è impostata nelle impostazioni del tuo account. Configurala per procedere.");
                const accountModal = document.getElementById('account-modal');
                if (accountModal) accountModal.style.display = 'flex';
            } else {
                console.warn('[GeminiAutoEval] API Key non impostata, salto la valutazione automatica.');
            }
            return;
        }

        if (allEmails.length === 0) {
            if (!silent) alert("Nessuna email da valutare.");
            return;
        }

        const emailIds = allEmails.map(e => e.id);

        if (!silent) {
            loadingSpinner.style.display = 'block';
            loadingMessage.style.display = 'block';
            loadingMessage.textContent = `Valutazione importanza con Gemini in corso per ${emailIds.length} email...`;
        } else {
            console.log(`[GeminiAutoEval] Avvio valutazione automatica per ${emailIds.length} email...`);
        }

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
            if (!silent) alert(result.message);
            else console.log(`[GeminiAutoEval] Valutazione completata: ${result.message}`);

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
            if (!silent) alert(`Errore durante la valutazione: ${error.message}`);
            else console.error(`[GeminiAutoEval] Errore: ${error.message}`);
        } finally {
            if (!silent) {
                loadingSpinner.style.display = 'none';
                loadingMessage.style.display = 'none';
                loadingMessage.textContent = '';
            }
        }
    }

    async function fetchAndDisplayEmails(isSilent = false, isFast = true) {
        // Ricarica i ticket Redmine aperti in background per la visualizzazione/highlight dei collegamenti
        loadOpenTickets().then(() => {
            if (typeof rerenderEmails === 'function') {
                rerenderEmails();
            }
        });

        if (!isSilent) {
            loadingSpinner.style.display = 'block';
            loadingMessage.style.display = 'block';
            loadingMessage.textContent = 'Sto scaricando le email dal server...';
        }

        const limit = emailLimitSelect.value;
        let errorOccurred = false;

        try {
            const url = `/api/emails?limit=${limit}${isFast ? '&fast=true' : ''}`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();

            // Decode HTML entities in snippet for all emails
            if (data.emails && Array.isArray(data.emails)) {
                data.emails.forEach(email => {
                    if (email.snippet) {
                        email.snippet = decodeHTMLEntities(email.snippet);
                    }
                });
            }

            // Check for real changes to prevent flickering, filtering out recently read emails
            const newEmails = (data.emails || []).filter(email => !readEmailIds.has(email.id));
            const newLabelMap = data.labelMap || {};
            const newAccountEmail = data.accountEmail || '';

            // Load saved pin states from localStorage
            let savedPinnedIds = [];
            try {
                savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
            } catch (e) {
                savedPinnedIds = [];
            }

            let explicitlyUnpinnedIds = [];
            try {
                explicitlyUnpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
            } catch (e) {
                explicitlyUnpinnedIds = [];
            }

            const pinnedSet = new Set(savedPinnedIds);
            const unpinnedSet = new Set(explicitlyUnpinnedIds);
            
            // Group emails by threadId to only auto-pin the latest one in each thread
            const threadLatestEmailMap = new Map();
            newEmails.forEach(email => {
                const dateValue = email.internalDate ? parseInt(email.internalDate, 10) : 0;
                const isOlderThan2Days = dateValue > 0 && (Date.now() - dateValue > 2 * 24 * 60 * 60 * 1000);
                const isUnread = email.labelIds && email.labelIds.includes('UNREAD');

                if (isOlderThan2Days && isUnread && !unpinnedSet.has(email.id)) {
                    const threadId = email.threadId || email.subject;
                    if (threadId) {
                        const existing = threadLatestEmailMap.get(threadId);
                        if (!existing || dateValue > (existing.internalDate ? parseInt(existing.internalDate, 10) : 0)) {
                            threadLatestEmailMap.set(threadId, email);
                        }
                    }
                }
            });

            const tempPinnedEmails = [];
            const tempAllEmails = [];

            newEmails.forEach(email => {
                const dateValue = email.internalDate ? parseInt(email.internalDate, 10) : 0;
                const isOlderThan2Days = dateValue > 0 && (Date.now() - dateValue > 2 * 24 * 60 * 60 * 1000);
                const isUnread = email.labelIds && email.labelIds.includes('UNREAD');

                const threadId = email.threadId || email.subject;
                const isLatestInThread = threadId && threadLatestEmailMap.get(threadId)?.id === email.id;

                if (isOlderThan2Days && isUnread && !unpinnedSet.has(email.id) && isLatestInThread) {
                    email.isPinned = true;
                    email.isAutoPinned = true;
                } else if (pinnedSet.has(email.id)) {
                    email.isPinned = true;
                    email.isAutoPinned = false;
                } else {
                    email.isPinned = false;
                    email.isAutoPinned = false;
                }

                if (email.isPinned) {
                    tempPinnedEmails.push(email);
                }
                tempAllEmails.push(email);
            });

            const allEmailsChanged = tempAllEmails.length !== allEmails.length ||
                tempAllEmails.some((e, i) => e.id !== allEmails[i]?.id || e.score !== allEmails[i]?.score || e.category !== allEmails[i]?.category);
            const pinnedEmailsChanged = tempPinnedEmails.length !== pinnedEmails.length ||
                tempPinnedEmails.some((e, i) => e.id !== pinnedEmails[i]?.id || e.score !== pinnedEmails[i]?.score || e.category !== pinnedEmails[i]?.category);

            const labelsChanged = JSON.stringify(newLabelMap) !== JSON.stringify(labelMap);
            const accountEmailChanged = newAccountEmail !== accountEmail;

            if (!allEmailsChanged && !pinnedEmailsChanged && !labelsChanged && !accountEmailChanged) {
                return;
            }

            allEmails = tempAllEmails;
            pinnedEmails = tempPinnedEmails;
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

    async function fetchAndDisplayReadEmails(isSilent = false, isFast = true) {
        if (!isSilent) {
            loadingSpinner.style.display = 'block';
            loadingMessage.style.display = 'block';
            loadingMessage.textContent = 'Sto scaricando le email lette dal server...';
        }

        const limit = emailLimitSelect.value;
        let errorOccurred = false;

        try {
            const url = `/api/emails?read=true&limit=${limit}${isFast ? '&fast=true' : ''}`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();

            // Decode HTML entities in snippet for all emails
            if (data.emails && Array.isArray(data.emails)) {
                data.emails.forEach(email => {
                    if (email.snippet) {
                        email.snippet = decodeHTMLEntities(email.snippet);
                    }
                });
            }

            readEmails = data.emails || [];

            applySorting();
            rerenderReadEmails();
            updateEmailStatus(true);
        } catch (error) {
            console.error('Error fetching read emails:', error);
            updateEmailStatus(false, 'Errore di connessione a Gmail');
            errorOccurred = true;
        } finally {
            if (!isSilent) {
                loadingSpinner.style.display = 'none';
                if (!errorOccurred) {
                    loadingMessage.style.display = 'none';
                    loadingMessage.textContent = '';
                }
            }
        }
    }

    function rerenderReadEmails() {
        const searchTerm = document.getElementById('email-search-input').value.toLowerCase();
        const categoryFilter = document.getElementById('gmail-category-select').value;

        let filteredEmails = readEmails;

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
            if (categoryFilter === 'CUSTOM_LABEL') {
                const customLabel = document.getElementById('custom-label-input').value.trim().toUpperCase();
                if (customLabel) {
                    filteredEmails = filteredEmails.filter(e => e.labelIds && e.labelIds.some(l => l.toUpperCase() === customLabel));
                }
            } else {
                filteredEmails = filteredEmails.filter(e => e.labelIds && e.labelIds.includes(categoryFilter));
            }
        }

        // Filtro per importanza
        const minImportanceSelect = document.getElementById('importance-min-select');
        const maxImportanceSelect = document.getElementById('importance-max-select');
        const minImportance = minImportanceSelect ? parseInt(minImportanceSelect.value, 10) : 0;
        const maxImportance = maxImportanceSelect ? parseInt(maxImportanceSelect.value, 10) : 100;

        filteredEmails = filteredEmails.filter(e => {
            const scorePercent = (typeof e.score === 'number') ? Math.round(e.score * 100) : 0;
            return scorePercent >= minImportance && scorePercent <= maxImportance;
        });

        // Update read-emails tab count
        const countBadge = document.getElementById('read-emails-count');
        if (countBadge) {
            countBadge.textContent = filteredEmails.length;
        }

        const readEmailsListContainer = document.getElementById('read-emails-list-container');
        displayEmails(filteredEmails, readEmailsListContainer, null, false);
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
            if (categoryFilter === 'CUSTOM_LABEL') {
                const customLabel = document.getElementById('custom-label-input').value.trim().toUpperCase();
                if (customLabel) {
                    filteredEmails = filteredEmails.filter(e => e.labelIds && e.labelIds.some(l => l.toUpperCase() === customLabel));
                }
            } else {
                filteredEmails = filteredEmails.filter(e => e.labelIds && e.labelIds.includes(categoryFilter));
            }
        }

        // Filtro per importanza
        const minImportanceSelect = document.getElementById('importance-min-select');
        const maxImportanceSelect = document.getElementById('importance-max-select');
        const minImportance = minImportanceSelect ? parseInt(minImportanceSelect.value, 10) : 0;
        const maxImportance = maxImportanceSelect ? parseInt(maxImportanceSelect.value, 10) : 100;

        filteredEmails = filteredEmails.filter(e => {
            const scorePercent = (typeof e.score === 'number') ? Math.round(e.score * 100) : 0;
            return scorePercent >= minImportance && scorePercent <= maxImportance;
        });

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

        const actualUnreadCount = otherEmails.filter(e => e.labelIds && e.labelIds.includes('UNREAD')).length;
        emailStats.textContent = `Email non lette: ${actualUnreadCount}`

        document.getElementById('human-count').textContent = humanEmails.length;
        document.getElementById('bot-count').textContent = botEmails.length;
        document.getElementById('cloud-monitor-count').textContent = filteredCloudIssues.length;

        displayEmails(humanEmails, humanEmailListContainer, humanHighlightedEmailsContainer, false);
        displayEmails(botEmails, botEmailListContainer, botHighlightedEmailsContainer, true);

        displayCloudMonitorEmails(filteredCloudIssues);
        renderStickyNotes(pinnedEmails);

        // Aggiorna il titolo del tab del browser (stile Gmail)
        const globalOther = allEmails.filter(e => !e.from || !e.from.includes('Cloud Monitor'));
        const globalUnreadHuman = globalOther.filter(e => e.category === 'Human' && e.labelIds && e.labelIds.includes('UNREAD')).length;
        const globalUnreadBot = globalOther.filter(e => e.category === 'Bot' && e.labelIds && e.labelIds.includes('UNREAD')).length;
        const globalUnreadTotal = globalOther.filter(e => e.labelIds && e.labelIds.includes('UNREAD')).length;

        if (globalUnreadTotal > 0) {
            document.title = `SmartSupport 👤${globalUnreadHuman}|🤖${globalUnreadBot}`;
        } else {
            document.title = "SmartSupport";
        }
    }

    function renderStickyNotes(pinnedEmails) {
        const container = document.getElementById('sticky-notes-container');
        if (!container) return;

        if (!pinnedEmails || pinnedEmails.length === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        // Safeguard if currently on Backup Hub tab
        const backupTab = document.getElementById('backup-tab');
        if (backupTab && backupTab.classList.contains('active')) {
            container.style.setProperty('display', 'none', 'important');
        } else {
            container.style.removeProperty('display');
            container.style.display = 'flex';
        }

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

            let oldBadgeHtml = '';
            const emailDate = email.internalDate ? parseInt(email.internalDate, 10) : 0;
            const isOlderThan2Days = emailDate > 0 && (Date.now() - emailDate > 2 * 24 * 60 * 60 * 1000);
            const isUnread = email.labelIds && email.labelIds.includes('UNREAD');
            if (isOlderThan2Days && isUnread) {
                const daysOld = Math.floor((Date.now() - emailDate) / (24 * 60 * 60 * 1000));
                oldBadgeHtml = `<div class="note-old-badge" title="Questa email è più vecchia di ${daysOld} giorni ed è stata pinnata in automatico."><i class="fa-solid fa-hourglass-end"></i> Vecchia (+${daysOld}gg)</div>`;
            }

            // Only update innerHTML if it's new or something changed (simplified: update always but it won't trigger transition)
            note.innerHTML = `
                <button class="note-pin" title="Unpin"><i class="fa-solid fa-thumbtack"></i></button>
                <div class="note-from">${DOMPurify.sanitize(email.from)}</div>
                <div class="note-subject">${DOMPurify.sanitize(email.subject)}</div>
                ${oldBadgeHtml}
                <div class="note-preview">${DOMPurify.sanitize(email.snippet)}</div>
                <div class="note-actions">
                    <button class="note-action-read" title="Segna come letta">
                        <i class="fa-solid fa-envelope-open"></i> Letta
                    </button>
                    <button class="note-action-l1" title="Assegna al Supporto Livello 1 (Progetto Maestrale Cloud)">
                        <i class="fa-solid fa-users-gear"></i> L1
                    </button>
                    <button class="note-action-l2" title="Assegna al Supporto Livello 2 (Progetto ID: 7312)">
                        <i class="fa-solid fa-user-shield"></i> L2
                    </button>
                </div>
                <div class="note-date">${dateStr}</div>
            `;

            note.querySelector('.note-pin').addEventListener('click', (e) => {
                e.stopPropagation();
                unpinEmail(email.id);
            });

            note.querySelector('.note-action-read').addEventListener('click', (e) => {
                e.stopPropagation();
                markSingleEmailAsRead(email.id, note);
            });

            note.querySelector('.note-action-l1').addEventListener('click', (e) => {
                e.stopPropagation();
                assignToLevel1(email, e.currentTarget);
            });

            note.querySelector('.note-action-l2').addEventListener('click', (e) => {
                e.stopPropagation();
                assignToLevel2(email, e.currentTarget);
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
        header.innerHTML = `<i class="fa-solid ${folderIconClass}"></i> <span>${DOMPurify.sanitize(groupKey)} (${group.length})</span>`;

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
                    ${DOMPurify.sanitize(email.subject)} 
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
                <div class="detail-row"><strong>Host:</strong> ${DOMPurify.sanitize(host)}</div>
                <div class="detail-row"><strong>Status:</strong> <span class="status-badge status-${status.toLowerCase()}">${DOMPurify.sanitize(status)}</span></div>

                <div class="detail-row"><strong>Snippet:</strong> ${DOMPurify.sanitize(email.snippet)}</div>
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

    function getCleanSenderName(fromStr) {
        if (!fromStr) return 'Sconosciuto';
        const match = fromStr.match(/^"?(.*?)"?\s*<.*>/);
        if (match && match[1]) {
            return match[1].trim();
        }
        const clean = fromStr.replace(/<.*>/, '').trim();
        if (clean) return clean;
        const emailMatch = fromStr.match(/<([^>]+)>/);
        if (emailMatch && emailMatch[1]) {
            return emailMatch[1].trim();
        }
        return fromStr;
    }

    function parseCheckmkSubject(subjectStr) {
        if (!subjectStr) return { isCheckmk: false };
        if (!subjectStr.toLowerCase().includes('checkmk')) {
            return { isCheckmk: false };
        }
        let cleanSub = subjectStr.replace(/^Checkmk:\s*/i, '').trim();
        
        // Detect transition status (e.g. OK -> WARN, ? -> CRIT, WARN -> OK)
        const transitionMatch = cleanSub.match(/(.*?)\s+(\S+)\s*->\s*(\S+)\s*$/);
        if (transitionMatch) {
            const serviceInfo = transitionMatch[1].trim();
            const fromStatus = transitionMatch[2].toUpperCase();
            const toStatus = transitionMatch[3].toUpperCase();
            
            const slashIdx = serviceInfo.indexOf('/');
            let host = 'N/A';
            let service = serviceInfo;
            if (slashIdx !== -1) {
                host = serviceInfo.substring(0, slashIdx).trim();
                service = serviceInfo.substring(slashIdx + 1).trim();
            }
            
            return {
                isCheckmk: true,
                host,
                service,
                fromStatus,
                toStatus,
                status: toStatus
            };
        }
        
        // Check for single status (e.g. "Checkmk: DELILIFE/Memory CRIT")
        const singleMatch = cleanSub.match(/(.*?)\s+(OK|CRIT|WARN|UNKNOWN|UP|DOWN|PENDING)\s*$/i);
        if (singleMatch) {
            const serviceInfo = singleMatch[1].trim();
            const status = singleMatch[2].toUpperCase();
            
            const slashIdx = serviceInfo.indexOf('/');
            let host = 'N/A';
            let service = serviceInfo;
            if (slashIdx !== -1) {
                host = serviceInfo.substring(0, slashIdx).trim();
                service = serviceInfo.substring(slashIdx + 1).trim();
            }
            
            return {
                isCheckmk: true,
                host,
                service,
                fromStatus: null,
                toStatus: status,
                status
            };
        }
        
        // Fallback for general Checkmk emails
        const slashIdx = cleanSub.indexOf('/');
        let host = 'N/A';
        let service = cleanSub;
        if (slashIdx !== -1) {
            host = cleanSub.substring(0, slashIdx).trim();
            service = cleanSub.substring(slashIdx + 1).trim();
        }
        return {
            isCheckmk: true,
            host,
            service,
            fromStatus: null,
            toStatus: 'UNKNOWN',
            status: 'UNKNOWN'
        };
    }

    function createThreadElement(emails, threadKey, processedIds) {
        // emails is assumed to be sorted chronologically (oldest to newest)
        const latestEmail = emails[emails.length - 1];

        const listItem = document.createElement('li');
        listItem.dataset.id = latestEmail.id;
        listItem.classList.add('email-item');
        listItem.classList.add('is-thread');

        listItem.addEventListener('contextmenu', (e) => {
            showContextMenu(e, latestEmail, listItem, true, emails);
        });

        // Drag and Drop configuration
        listItem.setAttribute('draggable', 'true');
        listItem.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', latestEmail.id);
            e.dataTransfer.effectAllowed = 'move';
            listItem.classList.add('dragging');
            showBoostPad();
        });
        listItem.addEventListener('dragend', () => {
            listItem.classList.remove('dragging');
            hideBoostPad();
        });

        // Highlight if latest email or any email in thread is important/red
        const parsedCheckmk = parseCheckmkSubject(latestEmail.subject);
        if (parsedCheckmk.isCheckmk) {
            if (['CRIT', 'DOWN'].includes(parsedCheckmk.status)) {
                listItem.classList.add('highlight-red');
            } else if (['WARN'].includes(parsedCheckmk.status)) {
                listItem.classList.add('highlight-yellow');
            } else if (['OK', 'UP'].includes(parsedCheckmk.status)) {
                listItem.classList.add('useless-email');
            }
        } else {
            const hasImportant = emails.some(e => e.score * 100 > 70);
            if (hasImportant) {
                listItem.classList.add('highlight-red');
            }
            // Useless if all emails are Bot
            const allBot = emails.every(e => e.category === 'Bot');
            if (allBot) {
                listItem.classList.add('useless-email');
            }
        }

        const mainContent = document.createElement('div');
        mainContent.className = 'email-main-content';

        const checkboxContainer = document.createElement('div');
        checkboxContainer.className = 'checkbox-wrapper';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        
        // Restore checked state if latest or all emails are checked
        checkbox.checked = emails.every(e => selectedEmailIds.has(e.id));
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            
            const isChecked = checkbox.checked;
            
            if (e.shiftKey && lastCheckedEmailId) {
                // Find all checkboxes in the active DOM
                const allCheckboxes = Array.from(document.querySelectorAll('.email-item input[type="checkbox"]'));
                const lastIdx = allCheckboxes.findIndex(cb => {
                    const item = cb.closest('.email-item');
                    return item && item.dataset.id === lastCheckedEmailId;
                });
                const currentIdx = allCheckboxes.indexOf(checkbox);
                
                if (lastIdx !== -1 && currentIdx !== -1) {
                    const start = Math.min(lastIdx, currentIdx);
                    const end = Math.max(lastIdx, currentIdx);
                    
                    for (let i = start; i <= end; i++) {
                        const cb = allCheckboxes[i];
                        cb.checked = isChecked;
                        const item = cb.closest('.email-item');
                        if (item) {
                            const id = item.dataset.id;
                            // Find matching email or emails in thread
                            const emailsToToggle = allEmails.filter(e => {
                                const eKey = e.threadId || cleanSubjectForComparison(e.subject);
                                return eKey === threadKey || e.id === id;
                            });
                            emailsToToggle.forEach(email => {
                                if (isChecked) {
                                    selectedEmailIds.add(email.id);
                                } else {
                                    selectedEmailIds.delete(email.id);
                                }
                            });
                        }
                    }
                }
            }
            
            lastCheckedEmailId = latestEmail.id;
        });
        
        checkbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            emails.forEach(email => {
                if (isChecked) selectedEmailIds.add(email.id);
                else selectedEmailIds.delete(email.id);
            });
        });
        checkboxContainer.appendChild(checkbox);

        const hasNotes = emails.some(e => e.hasNotes);
        if (hasNotes) {
            const noteBadge = document.createElement('div');
            noteBadge.className = 'note-indicator-badge';
            noteBadge.innerHTML = '<i class="fa-solid fa-note-sticky"></i>';
            noteBadge.title = 'Questo thread contiene delle note';
            checkboxContainer.appendChild(noteBadge);
        }
        checkboxContainer.addEventListener('click', (e) => e.stopPropagation());
        mainContent.appendChild(checkboxContainer);

        const emailDetails = document.createElement('div');
        emailDetails.className = 'email-details';

        const from = document.createElement('span');
        from.className = 'from';
        
        const uniqueSenders = [];
        emails.forEach(e => {
            const senderName = getCleanSenderName(e.from);
            if (!uniqueSenders.includes(senderName)) {
                uniqueSenders.push(senderName);
            }
        });
        from.innerHTML = `<span class="from-name">${DOMPurify.sanitize(uniqueSenders.join(', '))}</span>`;
        emailDetails.appendChild(from);

        const subject = document.createElement('span');
        subject.className = 'subject';
        
        const parsedCheckmkSubjectObj = parseCheckmkSubject(latestEmail.subject);
        if (parsedCheckmkSubjectObj.isCheckmk) {
            subject.classList.add('checkmk-subject');
            let statusHtml = '';
            if (parsedCheckmkSubjectObj.fromStatus) {
                statusHtml = `
                    <span class="status-badge status-${parsedCheckmkSubjectObj.fromStatus.toLowerCase()}">${DOMPurify.sanitize(parsedCheckmkSubjectObj.fromStatus)}</span>
                    <span class="status-arrow"><i class="fa-solid fa-arrow-right-long text-muted mx-1"></i></span>
                    <span class="status-badge status-${parsedCheckmkSubjectObj.status.toLowerCase()}">${DOMPurify.sanitize(parsedCheckmkSubjectObj.status)}</span>
                `;
            } else {
                statusHtml = `
                    <span class="status-badge status-${parsedCheckmkSubjectObj.status.toLowerCase()}">${DOMPurify.sanitize(parsedCheckmkSubjectObj.status)}</span>
                `;
            }

            subject.innerHTML = `
                <div class="checkmk-header-row">
                    <span class="checkmk-title">
                        <i class="fa-solid fa-server text-primary"></i> 
                        <strong>${DOMPurify.sanitize(parsedCheckmkSubjectObj.host)}</strong> 
                        <span class="text-muted">/</span> 
                        <span class="text-secondary">${DOMPurify.sanitize(parsedCheckmkSubjectObj.service)}</span>
                    </span>
                </div>
                <div class="checkmk-status-row">
                    <span class="text-muted" style="font-size: 0.75rem; font-weight: 500;">Status:</span>
                    ${statusHtml}
                </div>
            `;
        } else {
            subject.textContent = latestEmail.subject;
        }

        // Badge showing count of emails in this thread
        const threadBadge = document.createElement('span');
        threadBadge.className = 'thread-count-badge';
        threadBadge.innerHTML = `<i class="fa-solid fa-comments"></i> ${emails.length}`;
        threadBadge.title = `Questo thread contiene ${emails.length} messaggi`;
        
        const headerRow = subject.querySelector('.checkmk-header-row');
        if (headerRow) {
            headerRow.appendChild(threadBadge);
        } else {
            subject.appendChild(threadBadge);
        }
        emailDetails.appendChild(subject);

        // Render labels (from all emails in the thread, uniquely)
        const uniqueLabels = new Set();
        emails.forEach(e => {
            if (e.labelIds) {
                e.labelIds.forEach(l => uniqueLabels.add(l));
            }
        });
        if (uniqueLabels.size > 0) {
            const labelsContainer = document.createElement('div');
            labelsContainer.className = 'labels-container';
            uniqueLabels.forEach(label => {
                if (['UNREAD'].includes(label)) return;

                const badge = document.createElement('span');
                badge.className = `label-badge label-${label.toLowerCase().replace(/_/g, '-')}`;
                badge.textContent = labelMap[label] || label;
                labelsContainer.appendChild(badge);
            });
            emailDetails.appendChild(labelsContainer);
        }

        mainContent.appendChild(emailDetails);

        // Notes preview container (collect notes from all emails in thread)
        const allNotes = [];
        emails.forEach(e => {
            if (e.notes) {
                e.notes.forEach(n => {
                    if (!allNotes.some(existing => existing.id === n.id)) {
                        allNotes.push(n);
                    }
                });
            }
        });
        const notesPreview = document.createElement('div');
        notesPreview.className = 'email-notes-preview';
        renderNotesPreview(allNotes, notesPreview, latestEmail.id);
        notesPreview.addEventListener('click', (e) => {
            e.stopPropagation();
            openEmailNotesModal(latestEmail);
        });
        mainContent.appendChild(notesPreview);

        const emailMeta = document.createElement('div');
        emailMeta.className = 'email-meta';

        const scoreDiv = document.createElement('div');
        scoreDiv.className = 'score';
        scoreDiv.textContent = typeof latestEmail.score === 'number' ? `${Math.round(latestEmail.score * 100)}%` : 'N/A';
        emailMeta.appendChild(scoreDiv);

        const dateSpan = document.createElement('span');
        dateSpan.className = 'date';
        const dateValue = latestEmail.internalDate ? parseInt(latestEmail.internalDate, 10) : 0;
        if (dateValue > 0) {
            const date = new Date(dateValue);
            dateSpan.textContent = date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

            const isUnread = emails.some(e => e.labelIds && e.labelIds.includes('UNREAD'));
            if (isUnread && (Date.now() - dateValue > 2 * 24 * 60 * 60 * 1000)) {
                const daysOld = Math.floor((Date.now() - dateValue) / (24 * 60 * 60 * 1000));
                const oldBadge = document.createElement('span');
                oldBadge.className = 'old-email-list-badge';
                oldBadge.innerHTML = `<i class="fa-solid fa-hourglass-end"></i> Vecchia (+${daysOld}gg)`;
                oldBadge.title = `Questo thread ha un messaggio non letto da più di ${daysOld} giorni`;
                dateSpan.appendChild(oldBadge);
            }
        } else {
            dateSpan.textContent = '';
        }
        emailMeta.appendChild(dateSpan);

        const isPinned = pinnedEmails.some(pinnedEmail => emails.some(e => e.id === pinnedEmail.id));
        const pinButton = document.createElement('button');
        pinButton.className = 'btn btn-sm btn-outline-secondary pin-button';
        if (isPinned) {
            pinButton.innerHTML = '<i class="fa-solid fa-thumbtack text-danger"></i>';
            pinButton.title = 'Unpin thread';
            pinButton.addEventListener('click', (e) => {
                e.stopPropagation();
                // Unpin all emails in this thread
                emails.forEach(email => unpinEmail(email.id));
            });
        } else {
            pinButton.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
            pinButton.title = 'Pin thread';
            pinButton.addEventListener('click', (e) => {
                e.stopPropagation();
                // Pin latest email in this thread
                pinEmail(latestEmail.id);
            });
        }

        const cardActions = document.createElement('div');
        cardActions.className = 'card-actions';
        cardActions.addEventListener('click', (e) => e.stopPropagation());

        cardActions.appendChild(pinButton);

        // Reply Dropdown
        const replyDropdown = document.createElement('div');
        replyDropdown.className = 'reply-dropdown';

        const replyToggleBtn = document.createElement('button');
        replyToggleBtn.className = 'btn btn-sm btn-outline-secondary reply-toggle-btn';
        replyToggleBtn.innerHTML = '<i class="fa-solid fa-reply"></i>';
        replyToggleBtn.title = 'Rispondi / Rispondi a tutti';

        const replyDropdownMenu = document.createElement('div');
        replyDropdownMenu.className = 'reply-dropdown-menu';

        const rBtn = document.createElement('button');
        rBtn.innerHTML = '<i class="fa-solid fa-reply"></i> Rispondi';
        rBtn.title = 'Rispondi al mittente';
        rBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            replyDropdown.classList.remove('show');
            openReplyDropdownEmailId = null;
            openReplyModal(latestEmail, false);
        });

        const rAllBtn = document.createElement('button');
        rAllBtn.innerHTML = '<i class="fa-solid fa-reply-all"></i> Rispondi a tutti';
        rAllBtn.title = 'Rispondi a tutti';
        rAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            replyDropdown.classList.remove('show');
            openReplyDropdownEmailId = null;
            openReplyModal(latestEmail, true);
        });

        replyDropdownMenu.appendChild(rBtn);
        replyDropdownMenu.appendChild(rAllBtn);

        if (openReplyDropdownEmailId === latestEmail.id) {
            replyDropdown.classList.add('show');
        }

        replyToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willBeOpen = !replyDropdown.classList.contains('show');
            document.querySelectorAll('.reply-dropdown').forEach(d => {
                if (d !== replyDropdown) d.classList.remove('show');
            });
            replyDropdown.classList.toggle('show');
            openReplyDropdownEmailId = willBeOpen ? latestEmail.id : null;
        });

        replyDropdown.appendChild(replyToggleBtn);
        replyDropdown.appendChild(replyDropdownMenu);
        cardActions.appendChild(replyDropdown);

        const forwardButton = document.createElement('button');
        forwardButton.className = 'btn btn-sm btn-outline-secondary forward-button';
        forwardButton.innerHTML = '<i class="fa-solid fa-share"></i>';
        forwardButton.title = 'Inoltra il thread';
        forwardButton.addEventListener('click', (e) => {
            e.stopPropagation();
            openForwardModal(latestEmail);
        });
        cardActions.appendChild(forwardButton);

        const isThreadUnread = emails.some(e => e.labelIds && e.labelIds.includes('UNREAD'));
        const markAsReadButton = document.createElement('button');
        markAsReadButton.className = 'btn btn-sm btn-outline-secondary mark-read-single-btn';
        if (isThreadUnread) {
            markAsReadButton.innerHTML = '<i class="fa-solid fa-envelope-open"></i>';
            markAsReadButton.title = 'Segna thread come letto';
            markAsReadButton.addEventListener('click', (e) => {
                e.stopPropagation();
                markSingleEmailAsRead(latestEmail.id, listItem);
            });
        } else {
            markAsReadButton.innerHTML = '<i class="fa-solid fa-envelope"></i>';
            markAsReadButton.title = 'Segna thread come da leggere';
            markAsReadButton.addEventListener('click', (e) => {
                e.stopPropagation();
                markSingleEmailAsUnread(latestEmail.id, listItem);
            });
        }
        cardActions.appendChild(markAsReadButton);

        const redmineBtn = document.createElement('button');
        redmineBtn.className = 'btn btn-sm btn-redmine redmine-list-button';
        redmineBtn.innerHTML = '<i class="fa-solid fa-ticket"></i>';
        redmineBtn.title = 'Crea Ticket Redmine';
        redmineBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openRedmineModal(latestEmail);
        });
        cardActions.appendChild(redmineBtn);

        const linkTicketBtn = document.createElement('button');
        linkTicketBtn.className = 'btn btn-sm btn-outline-secondary link-ticket-list-button';
        linkTicketBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
        linkTicketBtn.title = 'Collega a ticket esistente';
        
        const cleanEmailSubject = cleanSubjectForComparison(latestEmail.subject);
        const matchingTicket = openTickets.find(t => cleanSubjectForComparison(t.subject) === cleanEmailSubject);
        if (matchingTicket) {
            linkTicketBtn.classList.remove('btn-outline-secondary');
            linkTicketBtn.classList.add('btn-warning', 'pulse-glow');
            linkTicketBtn.title = `Suggerimento: Collega al ticket #${matchingTicket.id}`;
        }
        linkTicketBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openLinkTicketModal(latestEmail, matchingTicket);
        });
        cardActions.appendChild(linkTicketBtn);

        // Escalation actions for thread (based on latest message)
        const escalationDropdown = document.createElement('div');
        escalationDropdown.className = 'escalation-dropdown';

        const escalateToggleBtn = document.createElement('button');
        escalateToggleBtn.className = 'btn btn-sm btn-outline-secondary escalate-toggle-btn';
        escalateToggleBtn.innerHTML = '<i class="fa-solid fa-headset"></i>';
        escalateToggleBtn.title = 'Assegna / Escalation Supporto';

        const escalationMenu = document.createElement('div');
        escalationMenu.className = 'escalation-menu';

        const l1Btn = document.createElement('button');
        l1Btn.className = 'btn btn-sm btn-assign-l1';
        l1Btn.innerHTML = '<i class="fa-solid fa-users-gear"></i> L1 Support';
        l1Btn.addEventListener('click', (e) => {
            e.stopPropagation();
            assignToLevel1(latestEmail, l1Btn);
            escalationDropdown.classList.remove('show');
            openEscalationEmailId = null;
        });

        const l2Btn = document.createElement('button');
        l2Btn.className = 'btn btn-sm btn-assign-l2';
        l2Btn.innerHTML = '<i class="fa-solid fa-user-shield"></i> L2 Support';
        l2Btn.addEventListener('click', (e) => {
            e.stopPropagation();
            assignToLevel2(latestEmail, l2Btn);
            escalationDropdown.classList.remove('show');
            openEscalationEmailId = null;
        });

        escalationMenu.appendChild(l1Btn);
        escalationMenu.appendChild(l2Btn);

        if (openEscalationEmailId === latestEmail.id) {
            escalationDropdown.classList.add('show');
        }

        escalateToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.escalation-dropdown').forEach(d => {
                if (d !== escalationDropdown) d.classList.remove('show');
            });
            const willBeOpen = !escalationDropdown.classList.contains('show');
            escalationDropdown.classList.toggle('show');
            openEscalationEmailId = willBeOpen ? latestEmail.id : null;
        });

        escalationDropdown.appendChild(escalateToggleBtn);
        escalationDropdown.appendChild(escalationMenu);
        cardActions.appendChild(escalationDropdown);

        const showButton = document.createElement('button');
        showButton.className = 'btn btn-sm btn-outline-secondary show-button';
        showButton.innerHTML = '&#128214;';
        showButton.title = 'Show full email';
        showButton.addEventListener('click', (e) => {
            e.stopPropagation();
            openFullScreenEmail(latestEmail);
        });
        cardActions.appendChild(showButton);

        emailMeta.appendChild(cardActions);
        mainContent.appendChild(emailMeta);
        listItem.appendChild(mainContent);

        const snippet = document.createElement('p');
        snippet.className = 'snippet';
        snippet.textContent = latestEmail.snippet;
        listItem.appendChild(snippet);

        // Construct thread container holding all emails
        const threadContainer = document.createElement('div');
        threadContainer.className = 'thread-container';
        threadContainer.addEventListener('click', e => e.stopPropagation());

        emails.forEach((email, index) => {
            const isLatest = index === emails.length - 1;
            
            const messageCard = document.createElement('div');
            messageCard.className = 'thread-message-card';
            if (isLatest) messageCard.classList.add('latest');

            // Header for single thread message
            const msgHeader = document.createElement('div');
            msgHeader.className = 'thread-message-header';
            
            const senderSpan = document.createElement('span');
            senderSpan.className = 'thread-message-sender';
            senderSpan.textContent = email.from;
            msgHeader.appendChild(senderSpan);

            const dateSpan = document.createElement('span');
            dateSpan.className = 'thread-message-date';
            const dateVal = email.internalDate ? parseInt(email.internalDate, 10) : 0;
            if (dateVal > 0) {
                const d = new Date(dateVal);
                dateSpan.textContent = d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            }
            msgHeader.appendChild(dateSpan);

            // Action buttons for specific message card
            const msgActions = document.createElement('div');
            msgActions.className = 'thread-message-actions';
            msgActions.addEventListener('click', (e) => e.stopPropagation());

            // Reply Dropdown
            const replyDropdown = document.createElement('div');
            replyDropdown.className = 'reply-dropdown';

            const replyToggleBtn = document.createElement('button');
            replyToggleBtn.className = 'btn btn-xs btn-outline-secondary reply-toggle-btn';
            replyToggleBtn.innerHTML = '<i class="fa-solid fa-reply"></i>';
            replyToggleBtn.title = 'Rispondi / Rispondi a tutti';

            const replyDropdownMenu = document.createElement('div');
            replyDropdownMenu.className = 'reply-dropdown-menu';

            const rBtnItem = document.createElement('button');
            rBtnItem.innerHTML = '<i class="fa-solid fa-reply"></i> Rispondi';
            rBtnItem.title = 'Rispondi';
            rBtnItem.addEventListener('click', (e) => {
                e.stopPropagation();
                replyDropdown.classList.remove('show');
                openReplyDropdownEmailId = null;
                openReplyModal(email, false);
            });

            const rAllBtn = document.createElement('button');
            rAllBtn.innerHTML = '<i class="fa-solid fa-reply-all"></i> Rispondi a tutti';
            rAllBtn.title = 'Rispondi a tutti';
            rAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                replyDropdown.classList.remove('show');
                openReplyDropdownEmailId = null;
                openReplyModal(email, true);
            });

            replyDropdownMenu.appendChild(rBtnItem);
            replyDropdownMenu.appendChild(rAllBtn);

            if (openReplyDropdownEmailId === email.id) {
                replyDropdown.classList.add('show');
            }

            replyToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const willBeOpen = !replyDropdown.classList.contains('show');
                document.querySelectorAll('.reply-dropdown').forEach(d => {
                    if (d !== replyDropdown) d.classList.remove('show');
                });
                replyDropdown.classList.toggle('show');
                openReplyDropdownEmailId = willBeOpen ? email.id : null;
            });

            replyDropdown.appendChild(replyToggleBtn);
            replyDropdown.appendChild(replyDropdownMenu);
            msgActions.appendChild(replyDropdown);

            const fBtn = document.createElement('button');
            fBtn.className = 'btn btn-xs btn-outline-secondary';
            fBtn.innerHTML = '<i class="fa-solid fa-share"></i>';
            fBtn.title = 'Inoltra';
            fBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openForwardModal(email);
            });
            msgActions.appendChild(fBtn);

            const redBtn = document.createElement('button');
            redBtn.className = 'btn btn-xs btn-redmine';
            redBtn.innerHTML = '<i class="fa-solid fa-ticket"></i>';
            redBtn.title = 'Crea Ticket';
            redBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openRedmineModal(email);
            });
            msgActions.appendChild(redBtn);

            const lnkBtn = document.createElement('button');
            lnkBtn.className = 'btn btn-xs btn-outline-secondary';
            lnkBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
            lnkBtn.title = 'Collega a ticket';
            
            const cSub = cleanSubjectForComparison(email.subject);
            const mTick = openTickets.find(t => cleanSubjectForComparison(t.subject) === cSub);
            if (mTick) {
                lnkBtn.classList.remove('btn-outline-secondary');
                lnkBtn.classList.add('btn-warning');
            }
            lnkBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openLinkTicketModal(email, mTick);
            });
            msgActions.appendChild(lnkBtn);

            const shBtn = document.createElement('button');
            shBtn.className = 'btn btn-xs btn-outline-secondary';
            shBtn.innerHTML = '&#128214;';
            shBtn.title = 'Full email';
            shBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openFullScreenEmail(email);
            });
            msgActions.appendChild(shBtn);

            msgHeader.appendChild(msgActions);
            messageCard.appendChild(msgHeader);

            const msgSnippet = document.createElement('div');
            msgSnippet.className = 'thread-message-snippet';
            msgSnippet.textContent = email.snippet;
            messageCard.appendChild(msgSnippet);

            const msgBody = document.createElement('div');
            msgBody.className = 'thread-message-body';
            if (email.bodyHtml) {
                const processedHtml = replaceCidsWithBase64(email.bodyHtml, email);
                try {
                    const shadowRoot = msgBody.attachShadow({ mode: 'open' });
                    const container = document.createElement('div');
                    container.innerHTML = DOMPurify.sanitize(processedHtml);
                    shadowRoot.appendChild(container);
                } catch (e) {
                    msgBody.innerHTML = DOMPurify.sanitize(processedHtml);
                }
            } else {
                msgBody.textContent = email.body;
            }
            messageCard.appendChild(msgBody);

            // Latest email is expanded by default, others collapsed
            if (isLatest) {
                msgBody.style.display = 'block';
                msgSnippet.style.display = 'none';
                messageCard.classList.add('expanded');
            } else {
                msgBody.style.display = 'none';
                msgSnippet.style.display = 'block';
                messageCard.classList.add('collapsed');
            }

            msgHeader.addEventListener('click', (e) => {
                e.stopPropagation();
                const isExpanded = msgBody.style.display === 'block';
                if (isExpanded) {
                    msgBody.style.display = 'none';
                    msgSnippet.style.display = 'block';
                    messageCard.classList.remove('expanded');
                    messageCard.classList.add('collapsed');
                } else {
                    msgBody.style.display = 'block';
                    msgSnippet.style.display = 'none';
                    messageCard.classList.remove('collapsed');
                    messageCard.classList.add('expanded');
                }
            });

            threadContainer.appendChild(messageCard);
        });

        listItem.appendChild(threadContainer);

        // Expanded/Collapsed state for the whole thread row item
        const isExpanded = expandedEmailIds.has(latestEmail.id);
        threadContainer.style.display = isExpanded ? 'flex' : 'none';

        listItem.addEventListener('click', () => {
            const isVisible = threadContainer.style.display === 'flex';
            threadContainer.style.display = isVisible ? 'none' : 'flex';

            if (!isVisible) {
                expandedEmailIds.add(latestEmail.id);
            } else {
                expandedEmailIds.delete(latestEmail.id);
            }
        });

        if (processedIds.has(latestEmail.id)) {
            listItem.classList.add('is-grouped');
        }

        return listItem;
    }

    function createEmailElement(email) {
        const listItem = document.createElement('li');
        listItem.dataset.id = email.id;
        listItem.classList.add('email-item');
        
        listItem.addEventListener('contextmenu', (e) => {
            showContextMenu(e, email, listItem, false, [email]);
        });
        
        // Drag and Drop configuration
        listItem.setAttribute('draggable', 'true');
        listItem.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', email.id);
            e.dataTransfer.effectAllowed = 'move';
            listItem.classList.add('dragging');
            showBoostPad();
        });
        listItem.addEventListener('dragend', () => {
            listItem.classList.remove('dragging');
            hideBoostPad();
        });

        const parsedCheckmk = parseCheckmkSubject(email.subject);
        if (parsedCheckmk.isCheckmk) {
            if (['CRIT', 'DOWN'].includes(parsedCheckmk.status)) {
                listItem.classList.add('highlight-red');
            } else if (['WARN'].includes(parsedCheckmk.status)) {
                listItem.classList.add('highlight-yellow');
            } else if (['OK', 'UP'].includes(parsedCheckmk.status)) {
                listItem.classList.add('useless-email');
            }
        } else {
            if (email.score * 100 > 70) {
                listItem.classList.add('highlight-red');
            }
            if (email.category === 'Bot') {
                listItem.classList.add('useless-email');
            }
        }

        const mainContent = document.createElement('div');
        mainContent.className = 'email-main-content';

        const checkboxContainer = document.createElement('div');
        checkboxContainer.className = 'checkbox-wrapper';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedEmailIds.has(email.id);
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            
            const isChecked = checkbox.checked;
            
            if (e.shiftKey && lastCheckedEmailId) {
                // Find all email checkboxes in the active DOM
                const allCheckboxes = Array.from(document.querySelectorAll('.email-item input[type="checkbox"]'));
                
                // Find index of the last checked checkbox
                const lastIdx = allCheckboxes.findIndex(cb => {
                    const item = cb.closest('.email-item');
                    return item && item.dataset.id === lastCheckedEmailId;
                });
                
                // Find index of the current checkbox
                const currentIdx = allCheckboxes.indexOf(checkbox);
                
                if (lastIdx !== -1 && currentIdx !== -1) {
                    const start = Math.min(lastIdx, currentIdx);
                    const end = Math.max(lastIdx, currentIdx);
                    
                    for (let i = start; i <= end; i++) {
                        const cb = allCheckboxes[i];
                        cb.checked = isChecked;
                        const id = cb.closest('.email-item').dataset.id;
                        if (isChecked) {
                            selectedEmailIds.add(id);
                        } else {
                            selectedEmailIds.delete(id);
                        }
                    }
                }
            }
            
            lastCheckedEmailId = email.id;
        });
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
        const senderName = getCleanSenderName(email.from);
        let senderEmail = '';
        const emailMatch = email.from.match(/<([^>]+)>/);
        if (emailMatch) {
            senderEmail = emailMatch[1];
        } else if (email.from.includes('@')) {
            senderEmail = email.from.replace(/^"|"$/g, '').trim();
        }
        if (senderEmail && senderName && senderName !== senderEmail) {
            from.innerHTML = `<span class="from-name">${DOMPurify.sanitize(senderName)}</span> <span class="from-email">&lt;${DOMPurify.sanitize(senderEmail)}&gt;</span>`;
        } else {
            from.innerHTML = `<span class="from-name">${DOMPurify.sanitize(senderName || email.from)}</span>`;
        }

        // Aggiunta badge di sicurezza ed esito controlli
        if (email.authFailures) {
            const authBadge = document.createElement('span');
            authBadge.className = 'security-warning-badge';
            authBadge.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Errore Autenticazione';
            authBadge.title = `Gmail ha rilevato un fallimento nei controlli di sicurezza (SPF/DKIM/DMARC).\nDettagli: ${email.authFailures.raw}`;
            from.appendChild(authBadge);
        }

        if (email.typosquattingWarning) {
            const tsBadge = document.createElement('span');
            tsBadge.className = 'security-warning-badge';
            tsBadge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Sospetto Typosquatting';
            tsBadge.title = `ATTENZIONE: Questo mittente invia da un dominio che somiglia a quello del cliente censito "${email.typosquattingWarning.clientName}" (${email.typosquattingWarning.matchedDomain}).`;
            from.appendChild(tsBadge);
        }

        if (email.isFirstTimeSender && email.projectName) {
            const ftBadge = document.createElement('span');
            ftBadge.className = 'first-time-sender-badge';
            ftBadge.innerHTML = `<i class="fa-solid fa-user-plus"></i> Primo Invio per ${DOMPurify.sanitize(email.projectName)}`;
            ftBadge.title = `Questo mittente (${senderEmail}) non ha mai inviato email per il cliente "${email.projectName}" in passato. Presta attenzione prima di cliccare su link o allegati.`;
            from.appendChild(ftBadge);
        }

        if (email.redmineTicketId) {
            const tktBadge = document.createElement('span');
            tktBadge.className = 'linked-ticket-badge';
            const projText = email.projectName ? `: ${email.projectName}` : '';
            tktBadge.innerHTML = `<i class="fa-solid fa-ticket"></i> Ticket #${email.redmineTicketId}${projText}`;
            tktBadge.title = `Email collegata al ticket Redmine #${email.redmineTicketId}${projText}`;
            from.appendChild(tktBadge);
        }

        emailDetails.appendChild(from);

        const subject = document.createElement('span');
        subject.className = 'subject';
        
        const parsedCheckmkSubjectObj = parseCheckmkSubject(email.subject);
        if (parsedCheckmkSubjectObj.isCheckmk) {
            subject.classList.add('checkmk-subject');
            let statusHtml = '';
            if (parsedCheckmkSubjectObj.fromStatus) {
                statusHtml = `
                    <span class="status-badge status-${parsedCheckmkSubjectObj.fromStatus.toLowerCase()}">${DOMPurify.sanitize(parsedCheckmkSubjectObj.fromStatus)}</span>
                    <span class="status-arrow"><i class="fa-solid fa-arrow-right-long text-muted mx-1"></i></span>
                    <span class="status-badge status-${parsedCheckmkSubjectObj.status.toLowerCase()}">${DOMPurify.sanitize(parsedCheckmkSubjectObj.status)}</span>
                `;
            } else {
                statusHtml = `
                    <span class="status-badge status-${parsedCheckmkSubjectObj.status.toLowerCase()}">${DOMPurify.sanitize(parsedCheckmkSubjectObj.status)}</span>
                `;
            }

            subject.innerHTML = `
                <div class="checkmk-header-row">
                    <span class="checkmk-title">
                        <i class="fa-solid fa-server text-primary"></i> 
                        <strong>${DOMPurify.sanitize(parsedCheckmkSubjectObj.host)}</strong> 
                        <span class="text-muted">/</span> 
                        <span class="text-secondary">${DOMPurify.sanitize(parsedCheckmkSubjectObj.service)}</span>
                    </span>
                </div>
                <div class="checkmk-status-row">
                    <span class="text-muted" style="font-size: 0.75rem; font-weight: 500;">Status:</span>
                    ${statusHtml}
                </div>
            `;
        } else {
            subject.textContent = email.subject;
        }
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

        // Notes preview container for desktop side-by-side view
        const notesPreview = document.createElement('div');
        notesPreview.className = 'email-notes-preview';
        renderNotesPreview(email.notes || [], notesPreview, email.id);
        notesPreview.addEventListener('click', (e) => {
            e.stopPropagation();
            openEmailNotesModal(email);
        });
        mainContent.appendChild(notesPreview);

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

            // Add a "Vecchia" badge next to the date in the list view if older than 2 days and unread
            const isUnread = email.labelIds && email.labelIds.includes('UNREAD');
            if (isUnread && (Date.now() - dateValue > 2 * 24 * 60 * 60 * 1000)) {
                const daysOld = Math.floor((Date.now() - dateValue) / (24 * 60 * 60 * 1000));
                const oldBadge = document.createElement('span');
                oldBadge.className = 'old-email-list-badge';
                oldBadge.innerHTML = `<i class="fa-solid fa-hourglass-end"></i> Vecchia (+${daysOld}gg)`;
                oldBadge.title = `Questa email è in attesa da più di ${daysOld} giorni ed è stata pinnata in automatico`;
                dateSpan.appendChild(oldBadge);
            }
        } else {
            dateSpan.textContent = '';
        }
        emailMeta.appendChild(dateSpan);


        const isPinned = pinnedEmails.some(pinnedEmail => pinnedEmail.id === email.id);
        const pinButton = document.createElement('button');
        pinButton.className = 'btn btn-sm btn-outline-secondary pin-button';
        if (isPinned) {
            pinButton.innerHTML = '<i class="fa-solid fa-thumbtack text-danger"></i>';
            pinButton.title = 'Unpin';
            pinButton.addEventListener('click', (e) => {
                e.stopPropagation();
                unpinEmail(email.id);
            });
        } else {
            pinButton.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
            pinButton.title = 'Pin';
            pinButton.addEventListener('click', (e) => {
                e.stopPropagation();
                pinEmail(email.id);
            });
        }

        const cardActions = document.createElement('div');
        cardActions.className = 'card-actions';

        cardActions.appendChild(pinButton);

        // Reply Dropdown
        const replyDropdown = document.createElement('div');
        replyDropdown.className = 'reply-dropdown';

        const replyToggleBtn = document.createElement('button');
        replyToggleBtn.className = 'btn btn-sm btn-outline-secondary reply-toggle-btn';
        replyToggleBtn.innerHTML = '<i class="fa-solid fa-reply"></i>';
        replyToggleBtn.title = 'Rispondi / Rispondi a tutti';

        const replyDropdownMenu = document.createElement('div');
        replyDropdownMenu.className = 'reply-dropdown-menu';

        const rBtn = document.createElement('button');
        rBtn.innerHTML = '<i class="fa-solid fa-reply"></i> Rispondi';
        rBtn.title = 'Rispondi a questa email';
        rBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            replyDropdown.classList.remove('show');
            openReplyDropdownEmailId = null;
            openReplyModal(email, false);
        });

        const rAllBtn = document.createElement('button');
        rAllBtn.innerHTML = '<i class="fa-solid fa-reply-all"></i> Rispondi a tutti';
        rAllBtn.title = 'Rispondi a tutti';
        rAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            replyDropdown.classList.remove('show');
            openReplyDropdownEmailId = null;
            openReplyModal(email, true);
        });

        replyDropdownMenu.appendChild(rBtn);
        replyDropdownMenu.appendChild(rAllBtn);

        if (openReplyDropdownEmailId === email.id) {
            replyDropdown.classList.add('show');
        }

        replyToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willBeOpen = !replyDropdown.classList.contains('show');
            document.querySelectorAll('.reply-dropdown').forEach(d => {
                if (d !== replyDropdown) d.classList.remove('show');
            });
            replyDropdown.classList.toggle('show');
            openReplyDropdownEmailId = willBeOpen ? email.id : null;
        });

        replyDropdown.appendChild(replyToggleBtn);
        replyDropdown.appendChild(replyDropdownMenu);
        cardActions.appendChild(replyDropdown);

        const forwardButton = document.createElement('button');
        forwardButton.className = 'btn btn-sm btn-outline-secondary forward-button';
        forwardButton.innerHTML = '<i class="fa-solid fa-share"></i>';
        forwardButton.title = 'Inoltra questa email';

        forwardButton.addEventListener('click', (e) => {
            e.stopPropagation(); // ESSENTIAL: Stop the click from opening the email body
            openForwardModal(email);
        });

        cardActions.appendChild(forwardButton);

        const isEmailUnread = email.labelIds && email.labelIds.includes('UNREAD');
        const markAsReadButton = document.createElement('button');
        markAsReadButton.className = 'btn btn-sm btn-outline-secondary mark-read-single-btn';
        if (isEmailUnread) {
            markAsReadButton.innerHTML = '<i class="fa-solid fa-envelope-open"></i>';
            markAsReadButton.title = 'Segna come letta';
            markAsReadButton.addEventListener('click', (e) => {
                e.stopPropagation();
                markSingleEmailAsRead(email.id, listItem);
            });
        } else {
            markAsReadButton.innerHTML = '<i class="fa-solid fa-envelope"></i>';
            markAsReadButton.title = 'Segna come da leggere';
            markAsReadButton.addEventListener('click', (e) => {
                e.stopPropagation();
                markSingleEmailAsUnread(email.id, listItem);
            });
        }
        cardActions.appendChild(markAsReadButton);

        const redmineBtn = document.createElement('button');
        redmineBtn.className = 'btn btn-sm btn-redmine redmine-list-button';
        redmineBtn.innerHTML = '<i class="fa-solid fa-ticket"></i>';
        redmineBtn.title = 'Crea Ticket Redmine';
        redmineBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openRedmineModal(email);
        });
        cardActions.appendChild(redmineBtn);

        const linkTicketBtn = document.createElement('button');
        linkTicketBtn.className = 'btn btn-sm btn-outline-secondary link-ticket-list-button';
        linkTicketBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
        linkTicketBtn.title = 'Collega a ticket esistente';
        
        // Controlla se c'è un ticket aperto con lo stesso oggetto per l'highlight visivo
        const cleanEmailSubject = cleanSubjectForComparison(email.subject);
        const matchingTicket = openTickets.find(t => cleanSubjectForComparison(t.subject) === cleanEmailSubject);
        if (matchingTicket) {
            linkTicketBtn.classList.remove('btn-outline-secondary');
            linkTicketBtn.classList.add('btn-warning', 'pulse-glow');
            linkTicketBtn.title = `Suggerimento: Collega al ticket #${matchingTicket.id} (Oggetto identico)`;
        }
        
        linkTicketBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openLinkTicketModal(email, matchingTicket);
        });
        cardActions.appendChild(linkTicketBtn);

        // Group L1 and L2 support actions into a beautiful escalation dropdown
        const escalationDropdown = document.createElement('div');
        escalationDropdown.className = 'escalation-dropdown';

        const escalateToggleBtn = document.createElement('button');
        escalateToggleBtn.className = 'btn btn-sm btn-outline-secondary escalate-toggle-btn';
        escalateToggleBtn.innerHTML = '<i class="fa-solid fa-headset"></i>';
        escalateToggleBtn.title = 'Assegna / Escalation Supporto';

        const escalationMenu = document.createElement('div');
        escalationMenu.className = 'escalation-menu';

        const l1Btn = document.createElement('button');
        l1Btn.className = 'btn btn-sm btn-assign-l1';
        l1Btn.innerHTML = '<i class="fa-solid fa-users-gear"></i> L1 Support';
        l1Btn.title = 'Assegna al Supporto Livello 1 (Progetto Maestrale Cloud)';
        l1Btn.addEventListener('click', (e) => {
            e.stopPropagation();
            assignToLevel1(email, l1Btn);
            escalationDropdown.classList.remove('show');
            openEscalationEmailId = null;
        });

        const l2Btn = document.createElement('button');
        l2Btn.className = 'btn btn-sm btn-assign-l2';
        l2Btn.innerHTML = '<i class="fa-solid fa-user-shield"></i> L2 Support';
        l2Btn.title = 'Assegna al Supporto Livello 2 (Progetto ID: 7312)';
        l2Btn.addEventListener('click', (e) => {
            e.stopPropagation();
            assignToLevel2(email, l2Btn);
            escalationDropdown.classList.remove('show');
            openEscalationEmailId = null;
        });

        escalationMenu.appendChild(l1Btn);
        escalationMenu.appendChild(l2Btn);

        // Restore open state if this email's escalation was open before re-render
        if (openEscalationEmailId === email.id) {
            escalationDropdown.classList.add('show');
        }

        escalateToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close other escalation dropdowns
            document.querySelectorAll('.escalation-dropdown').forEach(d => {
                if (d !== escalationDropdown) {
                    d.classList.remove('show');
                }
            });
            const willBeOpen = !escalationDropdown.classList.contains('show');
            escalationDropdown.classList.toggle('show');
            // Persist the open escalation email
            openEscalationEmailId = willBeOpen ? email.id : null;
        });

        escalationDropdown.appendChild(escalateToggleBtn);
        escalationDropdown.appendChild(escalationMenu);
        cardActions.appendChild(escalationDropdown);

        const shareButton = document.createElement('button');
        shareButton.className = 'btn btn-sm btn-outline-secondary share-list-button';
        shareButton.innerHTML = '<i class="fa-solid fa-share-nodes"></i>';
        shareButton.title = 'Condividi email';
        shareButton.addEventListener('click', (e) => {
            e.stopPropagation();
            const shareUrl = `${window.location.origin}${window.location.pathname}?emailId=${email.id}`;
            navigator.clipboard.writeText(shareUrl)
                .then(() => {
                    showToast('Link di condivisione copiato negli appunti!', 'success');
                })
                .catch(err => {
                    console.error('Errore durante la copia del link:', err);
                    alert(`Copia il link manualmente:\n${shareUrl}`);
                });
        });
        cardActions.appendChild(shareButton);

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
        
        function renderBodyContent() {
            body.innerHTML = '';
            if (email.bodyHtml) {
                const processedHtml = replaceCidsWithBase64(email.bodyHtml, email);
                try {
                    const shadowRoot = body.shadowRoot || body.attachShadow({ mode: 'open' });
                    shadowRoot.innerHTML = '';
                    const container = document.createElement('div');
                    container.innerHTML = DOMPurify.sanitize(processedHtml);
                    shadowRoot.appendChild(container);
                } catch (e) {
                    console.error('Shadow DOM not supported or failed to attach:', e);
                    body.innerHTML = DOMPurify.sanitize(processedHtml);
                }
            } else {
                body.textContent = email.body || '';
            }
        }

        // Prevent clicks inside the email body from collapsing the email item
        body.addEventListener('click', e => e.stopPropagation());

        // Restore expanded state
        const isExpanded = expandedEmailIds.has(email.id);
        body.style.display = isExpanded ? 'block' : 'none';
        
        if (isExpanded) {
            if (!email.body && !email.bodyHtml) {
                body.innerHTML = `<div class="text-center p-3 text-muted"><span class="spinner-border spinner-border-sm text-primary me-2"></span> Caricamento corpo...</div>`;
                fetch(`/api/emails/${email.id}`)
                    .then(res => res.json())
                    .then(fullEmail => {
                        Object.assign(email, fullEmail);
                        renderBodyContent();
                    })
                    .catch(err => {
                        body.innerHTML = `<div class="text-danger p-2"><i class="fa-solid fa-triangle-exclamation me-1"></i> Impossibile caricare il corpo.</div>`;
                    });
            } else {
                renderBodyContent();
            }
        }

        // Record scroll position on scroll
        body.addEventListener('scroll', () => {
            if (body.style.display === 'block') {
                emailBodyScrollPositions.set(email.id, body.scrollTop);
            }
        });

        // Restore scroll position if expanded and saved
        if (isExpanded && emailBodyScrollPositions.has(email.id)) {
            requestAnimationFrame(() => {
                body.scrollTop = emailBodyScrollPositions.get(email.id);
            });
        }

        listItem.appendChild(body);

        // Create Show Full Email button footer for the expanded preview
        const previewFooter = document.createElement('div');
        previewFooter.className = 'preview-footer';
        previewFooter.style.display = isExpanded ? 'flex' : 'none';
        
        const showFullBtn = document.createElement('button');
        showFullBtn.className = 'btn-show-full';
        showFullBtn.innerHTML = '<i class="fa-solid fa-up-right-from-square"></i> Apri Email Completa';
        showFullBtn.title = 'Apri email a schermo intero';
        
        showFullBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Avoid collapsing preview
            openFullScreenEmail(email);
        });
        
        previewFooter.appendChild(showFullBtn);
        
        // Prevent clicking the footer itself from collapsing the email item
        previewFooter.addEventListener('click', (e) => e.stopPropagation());

        listItem.appendChild(previewFooter);

        listItem.addEventListener('click', async () => {
            const isVisible = body.style.display === 'block';
            
            if (!isVisible) {
                expandedEmailIds.add(email.id);
                body.style.display = 'block';
                previewFooter.style.display = 'flex';

                if (!email.body && !email.bodyHtml) {
                    body.innerHTML = `<div class="text-center p-3 text-muted"><span class="spinner-border spinner-border-sm text-primary me-2"></span> Caricamento corpo...</div>`;
                    try {
                        const res = await fetch(`/api/emails/${email.id}`);
                        if (!res.ok) throw new Error('Errore nel recupero dell\'email');
                        const fullEmail = await res.json();
                        Object.assign(email, fullEmail);
                        renderBodyContent();
                    } catch (err) {
                        body.innerHTML = `<div class="text-danger p-2"><i class="fa-solid fa-triangle-exclamation me-1"></i> Impossibile caricare il corpo dell'email.</div>`;
                    }
                } else {
                    renderBodyContent();
                }
            } else {
                expandedEmailIds.delete(email.id);
                body.style.display = 'none';
                previewFooter.style.display = 'none';
                emailBodyScrollPositions.delete(email.id); // Clean up scroll position when collapsed
            }
        });

        return listItem;
    }

    function logPinActivity(email, isPinned) {
        fetch('/api/activity-log/email-pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                emailId: email.id,
                subject: email.subject || 'Senza Oggetto',
                from: email.from || 'Sconosciuto',
                isPinned: isPinned
            })
        }).catch(err => console.error('Errore logging pin/unpin email:', err));
    }

    function pinEmail(emailId) {
        const email = allEmails.find(e => e.id === emailId);
        if (email) {
            email.isPinned = true;
            email.isAutoPinned = false;
            if (!pinnedEmails.some(e => e.id === emailId)) {
                pinnedEmails.push(email);
            }

            // Persist pin state in localStorage
            let savedPinnedIds = [];
            try {
                savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
            } catch (e) {}
            if (!savedPinnedIds.includes(emailId)) {
                savedPinnedIds.push(emailId);
                localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));
            }

            // Remove from explicitly unpinned list
            let unpinnedIds = [];
            try {
                unpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
            } catch (e) {}
            unpinnedIds = unpinnedIds.filter(id => id !== emailId);
            localStorage.setItem('explicitly_unpinned_email_ids', JSON.stringify(unpinnedIds));

            // Log pin activity
            logPinActivity(email, true);

            rerenderEmails();
        }
    }

    function unpinEmail(emailId) {
        const emailIndex = pinnedEmails.findIndex(e => e.id === emailId);
        if (emailIndex > -1) {
            const [unpinnedEmail] = pinnedEmails.splice(emailIndex, 1);
            unpinnedEmail.isPinned = false;
            unpinnedEmail.isAutoPinned = false;

            const emailInAll = allEmails.find(e => e.id === emailId);
            if (emailInAll) {
                emailInAll.isPinned = false;
                emailInAll.isAutoPinned = false;
            } else {
                allEmails.push(unpinnedEmail);
            }

            // Persist unpin state in localStorage
            let savedPinnedIds = [];
            try {
                savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
            } catch (e) {}
            savedPinnedIds = savedPinnedIds.filter(id => id !== emailId);
            localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));

            // Add to explicitly unpinned list so it's not auto-pinned on refresh
            let unpinnedIds = [];
            try {
                unpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
            } catch (e) {}
            if (!unpinnedIds.includes(emailId)) {
                unpinnedIds.push(emailId);
                localStorage.setItem('explicitly_unpinned_email_ids', JSON.stringify(unpinnedIds));
            }

            // Log unpin activity
            logPinActivity(unpinnedEmail, false);

            rerenderEmails();
        }
    }

    function createPairBoxElement(group, groupKey, emoji) {
        const box = document.createElement('div');
        box.className = 'pair-box';
        box.dataset.emailIds = group.map(email => email.id).join(',');
        box.dataset.groupKey = groupKey;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'pair-checkbox';
        // Restore checked state from persistent set
        checkbox.checked = selectedPairGroupKeys.has(groupKey);
        checkbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            // Persist pair-box checked state
            if (isChecked) selectedPairGroupKeys.add(groupKey);
            else selectedPairGroupKeys.delete(groupKey);
            group.forEach(email => {
                const emailListItem = document.querySelector(`.email-item[data-id="${email.id}"]`);
                if (emailListItem) {
                    const innerCheckbox = emailListItem.querySelector('input[type="checkbox"]');
                    if (innerCheckbox) {
                        innerCheckbox.checked = isChecked;
                        if (isChecked) selectedEmailIds.add(email.id);
                        else selectedEmailIds.delete(email.id);
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

    function cleanupTumbleweed() {
        const overlay = document.querySelector('.tumbleweed-overlay');
        if (overlay) {
            if (overlay.cleanupTumbleweed) {
                overlay.cleanupTumbleweed();
            } else {
                overlay.remove();
            }
        }
    }

    function triggerTumbleweed() {
        if (document.querySelector('.tumbleweed-overlay')) {
            return;
        }
        const now = Date.now();
        if (window.lastTumbleweedSpawn && (now - window.lastTumbleweedSpawn < 15000)) {
            return;
        }
        window.lastTumbleweedSpawn = now;

        const overlay = document.createElement('div');
        overlay.className = 'tumbleweed-overlay';

        const tumbleweed = document.createElement('div');
        tumbleweed.className = 'tumbleweed-body';

        tumbleweed.innerHTML = `
            <svg class="tumbleweed-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                <!-- Overlapping irregular outer loops/branches (non-circular) -->
                <path d="M 20 40 C 15 20, 45 10, 65 15 C 80 20, 85 40, 80 65 C 75 80, 50 85, 30 80 C 15 75, 10 55, 20 40 Z" fill="none" stroke="#8c6239" stroke-width="2" opacity="0.85" />
                <path d="M 35 25 C 20 30, 20 60, 40 75 C 60 90, 80 75, 75 50 C 70 25, 50 20, 35 25 Z" fill="none" stroke="#734d26" stroke-width="2" opacity="0.9" />
                <path d="M 50 15 C 30 15, 25 45, 35 60 C 45 75, 65 75, 70 55 C 75 35, 70 15, 50 15 Z" fill="none" stroke="#5c3a21" stroke-width="2.2" opacity="0.85" />
                <path d="M 30 50 Q 25 25 50 20 T 75 50 Q 75 75 50 80 T 30 50 Z" fill="none" stroke="#a07040" stroke-width="1.8" opacity="0.8" />
                <path d="M 40 40 Q 30 55 50 65 T 60 40 Q 70 30 50 35 T 40 40 Z" fill="none" stroke="#8c6239" stroke-width="1.5" opacity="0.85" />
                
                <!-- Branching twigs/spikes pointing outwards for a prickly, dried look -->
                <!-- Top-Left Twig -->
                <path d="M 30 20 L 15 12 L 8 16 M 15 12 L 18 2" fill="none" stroke="#8c6239" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                <!-- Top-Right Twig -->
                <path d="M 70 20 L 82 10 L 90 14 M 82 10 L 80 2" fill="none" stroke="#a07040" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                <!-- Bottom-Right Twig -->
                <path d="M 80 65 L 92 75 L 95 85 M 92 75 L 85 82" fill="none" stroke="#734d26" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                <!-- Bottom-Left Twig -->
                <path d="M 30 80 L 18 90 L 10 85 M 18 90 L 22 98" fill="none" stroke="#5c3a21" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                
                <!-- Side/Radial prickly spikes -->
                <!-- Left-side spikes -->
                <path d="M 15 45 L 3 42 M 16 52 L 5 55 M 22 62 L 14 67" fill="none" stroke="#734d26" stroke-width="1.6" stroke-linecap="round" />
                <!-- Right-side spikes -->
                <path d="M 85 45 L 97 48 M 84 55 L 95 52 M 78 35 L 86 30" fill="none" stroke="#8c6239" stroke-width="1.6" stroke-linecap="round" />
                <!-- Top spikes -->
                <path d="M 50 15 L 52 4 M 42 16 L 38 7 M 58 16 L 62 6" fill="none" stroke="#a07040" stroke-width="1.5" stroke-linecap="round" />
                <!-- Bottom spikes -->
                <path d="M 50 85 L 48 96 M 60 84 L 64 93 M 40 84 L 36 92" fill="none" stroke="#5c3a21" stroke-width="1.8" stroke-linecap="round" />
                
                <!-- Inner chaotic dry branches/sticks traversing the center to break the circular shape -->
                <path d="M 25 35 L 75 65" fill="none" stroke="#734d26" stroke-width="1.6" stroke-linecap="round" />
                <path d="M 70 30 L 30 70" fill="none" stroke="#5c3a21" stroke-width="1.6" stroke-linecap="round" />
                <path d="M 20 50 L 80 50" fill="none" stroke="#8c6239" stroke-width="1.5" stroke-linecap="round" />
                <path d="M 50 20 L 50 80" fill="none" stroke="#a07040" stroke-width="1.5" stroke-linecap="round" />
                
                <!-- Random small secondary twigs/thorns inside -->
                <path d="M 40 45 L 35 48 M 45 40 L 48 35 M 55 55 L 60 58 M 60 45 L 65 42" fill="none" stroke="#5c3a21" stroke-width="1.5" stroke-linecap="round" />
            </svg>
        `;

        overlay.appendChild(tumbleweed);
        document.body.appendChild(overlay);

        // Physics State variables
        let x = -120;             // Horizontal position (px)
        let y = 0;                // Height above ground (px)
        let vx = 2.5;             // Horizontal velocity (px/frame)
        let vy = 4.0;             // Vertical velocity (px/frame)
        let theta = 0;            // Rotation angle (rad)
        let omega = 0.05;         // Angular velocity (rad/frame)

        const radius = 50;        // Tumbleweed radius
        const g = 0.22;           // Gravity (px/frame^2)
        const windSpeedBase = 5;  // Base wind velocity
        const windDrag = 0.03;    // How fast wind accelerates the tumbleweed
        const groundLevel = 0;    // Ground level is y = 0
        let lastDustTime = 0;     // Timestamp of last dust particle

        let animationFrameId = null;

        function spawnDust(px, py, count = 1, force = 1) {
            for (let i = 0; i < count; i++) {
                const dust = document.createElement('div');
                dust.className = 'tumbleweed-dust';
                
                const size = Math.random() * 12 + 8 * force;
                dust.style.width = `${size}px`;
                dust.style.height = `${size}px`;
                
                dust.style.left = `${px + (Math.random() - 0.5) * 20}px`;
                dust.style.top = `${py + (Math.random() - 0.5) * 10}px`;

                document.body.appendChild(dust);
                setTimeout(() => dust.remove(), 1200);
            }
        }

        function update() {
            // 1. Wind speed with sinusoidal gustiness
            const timeFactor = Date.now() * 0.001;
            const windSpeed = windSpeedBase + Math.sin(timeFactor * 1.5) * 2.5 + Math.cos(timeFactor * 0.7) * 1.5;
            
            // Wind acceleration
            vx += (windSpeed - vx) * windDrag;

            // 2. Air resistance
            vx *= 0.998;
            vy *= 0.998;

            // 3. Gravity
            vy -= g;

            // 4. Update positions
            x += vx;
            y += vy;

            // 5. Ground collision
            if (y <= groundLevel) {
                y = groundLevel;
                
                if (vy < -0.5) {
                    // Spawn dust puff on impact
                    const rect = tumbleweed.getBoundingClientRect();
                    const impactForce = Math.min(3, Math.abs(vy) / 2);
                    spawnDust(
                        rect.left + rect.width / 2, 
                        rect.top + rect.height - 10, 
                        Math.floor(impactForce * 2) + 1, 
                        impactForce
                    );
                    
                    // Bounce
                    vy = -vy * (0.65 + Math.random() * 0.15); // Restitution coefficient
                    
                    // Random hop & rotation nudge from collision with terrain bumps
                    vy += Math.random() * 0.8;
                    omega += (Math.random() - 0.5) * 0.1;
                } else {
                    vy = 0;
                }

                // Friction coupling with ground (linear velocity couples with angular velocity)
                const friction = 0.25;
                const slip = omega * radius - vx;
                vx += slip * friction;
                omega -= (slip * friction) / radius;

                // Ground rolling resistance
                omega *= 0.98;
                vx *= 0.99;

                // Micro-bumps on ground (pebbles, sticks) causing small pops
                if (vx > 1.5 && Math.random() < 0.04) {
                    vy += Math.random() * 1.8 + 0.5;
                    omega += (Math.random() - 0.5) * 0.08;
                }
            }

            // 6. Updrafts / wind lift random chance
            if (y === groundLevel && vx > 2 && Math.random() < 0.008) {
                vy += Math.random() * 3.5 + 1.5;
                omega += (Math.random() - 0.5) * 0.12;
            }

            // 7. Update angle
            theta += omega;

            // 8. Transform DOM element (CSS translateY is negative for upward height)
            tumbleweed.style.transform = `translate(${x}px, ${-y}px) rotate(${theta}rad)`;

            // 9. Periodic rolling dust trail
            const nowMs = Date.now();
            if (y < 12 && vx > 1.5 && nowMs - lastDustTime > 150) {
                const rect = tumbleweed.getBoundingClientRect();
                if (rect.left >= 0 && rect.left <= window.innerWidth) {
                    spawnDust(rect.left + rect.width / 4, rect.top + rect.height - 10, 1, 0.8);
                    lastDustTime = nowMs;
                }
            }

            // 10. Repeat until offscreen
            if (x > window.innerWidth + 150) {
                cleanup();
            } else {
                animationFrameId = requestAnimationFrame(update);
            }
        }

        function cleanup() {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            overlay.remove();
        }

        overlay.cleanupTumbleweed = cleanup;
        animationFrameId = requestAnimationFrame(update);
    }

    function displayEmails(emailsToDisplay, listContainer, highlightedContainer, showGroups) {
        if (!listContainer) return;
        
        // Save current listContainer scroll position
        const previousScrollTop = listContainer.scrollTop;
        
        listContainer.innerHTML = '';
        if (highlightedContainer) {
            highlightedContainer.innerHTML = '';
        }

        if (!emailsToDisplay || emailsToDisplay.length === 0) {
            listContainer.innerHTML = '<p>No unread emails found in this category.</p>';
            if (listContainer.offsetParent !== null) {
                triggerTumbleweed();
            }
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

            const groupKeys = Object.keys(groups).filter(gk => groups[gk] && groups[gk].length > 0);
            const numProblems = groupKeys.length;

            if (numProblems >= 2) {
                // Raggruppamento dei raggruppamenti (Master container)
                const masterBox = document.createElement('div');
                masterBox.className = 'self-resolved-master-box';

                // Master Header with inline alert
                const masterHeader = document.createElement('div');
                masterHeader.className = 'self-resolved-master-header';

                const infoDiv = document.createElement('div');
                infoDiv.className = 'self-resolved-master-info';

                const badge = document.createElement('div');
                badge.className = 'self-resolved-master-badge';
                badge.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
                infoDiv.appendChild(badge);

                const title = document.createElement('h3');
                title.className = 'self-resolved-master-title';
                title.innerHTML = `<span>${numProblems}</span> problemi si sono risolti da soli. Vuoi segnarli letti?`;
                infoDiv.appendChild(title);
                masterHeader.appendChild(infoDiv);

                // Collect all email IDs to mark as read
                const emailIdsToMark = [];
                groupKeys.forEach(gk => {
                    groups[gk].forEach(email => {
                        if (!emailIdsToMark.includes(email.id)) {
                            emailIdsToMark.push(email.id);
                        }
                    });
                });

                const confirmBtn = document.createElement('button');
                confirmBtn.className = 'self-resolved-master-btn';
                confirmBtn.innerHTML = '<i class="fa-solid fa-envelope-open me-2"></i>Sì, segna letti';
                confirmBtn.addEventListener('click', async () => {
                    confirmBtn.disabled = true;
                    confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-2"></i>Segnando...';
                    try {
                        await markMultipleEmailsAsReadDirectly(emailIdsToMark);
                    } catch (err) {
                        console.error(err);
                        confirmBtn.disabled = false;
                        confirmBtn.innerHTML = '<i class="fa-solid fa-envelope-open me-2"></i>Sì, segna letti';
                    }
                });
                masterHeader.appendChild(confirmBtn);
                masterBox.appendChild(masterHeader);

                // Grid container for nested group elements
                const gridContainer = document.createElement('div');
                gridContainer.className = 'self-resolved-nested-container';

                groupKeys.forEach((groupKey, index) => {
                    const group = groups[groupKey];
                    const emoji = emojis[index % emojis.length];
                    const pairBox = createPairBoxElement(group, groupKey, emoji);
                    gridContainer.appendChild(pairBox);
                });
                masterBox.appendChild(gridContainer);
                highlightedContainer.appendChild(masterBox);
            } else {
                // Render groups individually if 2 or fewer
                Object.entries(groups).forEach(([groupKey, group], index) => {
                    if (group.length > 0) {
                        const emoji = emojis[index % emojis.length];
                        const pairBox = createPairBoxElement(group, groupKey, emoji);
                        highlightedContainer.appendChild(pairBox);
                    }
                });
            }
        }

        const regularEmailList = document.createElement('ul');
        
        // Group emailsToDisplay by thread
        const threadGroups = new Map();
        const threadOrder = [];
        
        emailsToDisplay.forEach(email => {
            const threadKey = email.threadId || cleanSubjectForComparison(email.subject);
            if (!threadGroups.has(threadKey)) {
                threadGroups.set(threadKey, []);
                threadOrder.push(threadKey);
            }
            threadGroups.get(threadKey).push(email);
        });
        
        threadOrder.forEach(threadKey => {
            const threadEmails = threadGroups.get(threadKey);
            
            // Sort ascending by internalDate to display chronologically inside the thread
            threadEmails.sort((a, b) => {
                const dateA = parseInt(a.internalDate, 10) || 0;
                const dateB = parseInt(b.internalDate, 10) || 0;
                return dateA - dateB;
            });
            
            let emailElement;
            if (threadEmails.length === 1) {
                emailElement = createEmailElement(threadEmails[0]);
                if (processedIds.has(threadEmails[0].id)) {
                    emailElement.classList.add('is-grouped');
                }
            } else {
                emailElement = createThreadElement(threadEmails, threadKey, processedIds);
            }
            
            regularEmailList.appendChild(emailElement);
        });

        listContainer.appendChild(regularEmailList);
        
        // Restore scroll position
        listContainer.scrollTop = previousScrollTop;
    }

    function setupAutoRefresh() {
        if (!autoRefreshSelect) return;
        const interval = parseInt(autoRefreshSelect.value, 10);

        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }

        if (interval > 0) {
            refreshTimer = setInterval(() => fetchAndDisplayEmails(true, false), interval * 1000);
        }
    }

    // autoRefreshSelect.addEventListener('change', setupAutoRefresh); // REMOVED
    emailLimitSelect.addEventListener('change', () => {
        const activeTab = document.querySelector('.nav-link.active')?.id;
        if (activeTab === 'read-emails-tab') {
            fetchAndDisplayReadEmails(false, true);
        } else {
            fetchAndDisplayEmails(false);
        }
    });

    const gmailCategorySelect = document.getElementById('gmail-category-select');
    if (gmailCategorySelect) {
        gmailCategorySelect.addEventListener('change', () => {
            const activeTab = document.querySelector('.nav-link.active')?.id;
            if (activeTab === 'read-emails-tab') {
                rerenderReadEmails();
            } else {
                rerenderEmails();
            }
        });
    }

    const customLabelInput = document.getElementById('custom-label-input');
    if (customLabelInput) {
        customLabelInput.addEventListener('input', () => {
            const activeTab = document.querySelector('.nav-link.active')?.id;
            if (activeTab === 'read-emails-tab') {
                rerenderReadEmails();
            } else {
                rerenderEmails();
            }
        });
    }

    const minImportanceSelect = document.getElementById('importance-min-select');
    const maxImportanceSelect = document.getElementById('importance-max-select');
    [minImportanceSelect, maxImportanceSelect].forEach(select => {
        if (select) {
            select.addEventListener('change', () => {
                const activeTab = document.querySelector('.nav-link.active')?.id;
                if (activeTab === 'read-emails-tab') {
                    rerenderReadEmails();
                } else {
                    rerenderEmails();
                }
            });
        }
    });

    const cloudHoursSelect = document.getElementById('cloud-hours-select');
    if (cloudHoursSelect) {
        cloudHoursSelect.addEventListener('change', () => rerenderEmails());
    }

    // Manual Refresh Button
    const manualRefreshBtn = document.getElementById('refresh-emails-btn');
    if (manualRefreshBtn) {
        manualRefreshBtn.addEventListener('click', () => {
            const activeTab = document.querySelector('.nav-link.active')?.id;
            if (activeTab === 'read-emails-tab') {
                fetchAndDisplayReadEmails(false, false);
            } else {
                fetchAndDisplayEmails(false, false);
                fetchRedmineIssues(true);
            }
            const icon = manualRefreshBtn.querySelector('i');
            if (icon) {
                icon.classList.add('fa-spin');
                setTimeout(() => icon.classList.remove('fa-spin'), 1000);
            }
        });
    }

    // Read/Fetch Emails Center Button
    const readEmailsBtn = document.getElementById('read-emails-btn');
    if (readEmailsBtn) {
        readEmailsBtn.addEventListener('click', () => {
            const activeTab = document.querySelector('.nav-link.active')?.id;
            if (activeTab === 'read-emails-tab') {
                handleMarkAction('unread');
            } else {
                handleMarkAction('read');
            }
            const icon = readEmailsBtn.querySelector('i');
            if (icon) {
                icon.classList.add('fa-bounce');
                setTimeout(() => icon.classList.remove('fa-bounce'), 1000);
            }
        });
    }

    // --- Utenti Connessi ---
    async function fetchAndDisplayActiveUsers() {
        const wrapper = document.getElementById('active-users-wrapper');
        const countSpan = document.getElementById('active-users-count');
        const listContainer = document.getElementById('active-users-list');
        
        if (!wrapper || !countSpan || !listContainer) return;
        
        try {
            const response = await fetch('/api/active-users');
            if (!response.ok) {
                if (response.status === 401) {
                    wrapper.style.display = 'none';
                }
                return;
            }
            const data = await response.json();
            const activeUsersList = data.activeUsers || [];
            
            // Aggiorna il contatore
            countSpan.textContent = activeUsersList.length;
            wrapper.style.display = 'flex';
            
            // Svuota e popola la lista
            listContainer.innerHTML = '';
            
            if (activeUsersList.length === 0) {
                const emptyLi = document.createElement('li');
                emptyLi.style.color = 'var(--text-light-color)';
                emptyLi.style.fontStyle = 'italic';
                emptyLi.style.padding = '8px 12px';
                emptyLi.textContent = 'Nessun utente online';
                listContainer.appendChild(emptyLi);
            } else {
                activeUsersList.forEach(user => {
                    const li = document.createElement('li');
                    
                    // Crea l'avatar
                    const avatar = document.createElement('div');
                    avatar.className = 'active-users-avatar';
                    
                    const initials = user.split('.')
                        .map(p => p.charAt(0).toUpperCase())
                        .join('')
                        .substring(0, 2) || '?';
                    avatar.textContent = initials;
                    
                    // Genera un colore HSL dinamico coerente per l'avatar basato sullo username
                    let hash = 0;
                    for (let i = 0; i < user.length; i++) {
                        hash = user.charCodeAt(i) + ((hash << 5) - hash);
                    }
                    const hue = Math.abs(hash) % 360;
                    avatar.style.backgroundColor = `hsl(${hue}, 65%, 45%)`;
                    
                    // Nome formattato
                    const nameSpan = document.createElement('span');
                    nameSpan.textContent = user.split('.')
                        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
                        .join(' ');
                    
                    li.appendChild(avatar);
                    li.appendChild(nameSpan);
                    listContainer.appendChild(li);
                });
            }
        } catch (error) {
            console.error('Errore durante il recupero degli utenti attivi:', error);
        }
    }

    // Silent background refresh every 10 seconds
    setInterval(() => {
        fetchAndDisplayEmails(true, false);
        fetchRedmineIssues(true);
    }, 10000);

    (async () => {
        loadAppVersion();
        loadContacts();
        await fetchAndDisplayEmails(false, true); // Instant cached load
        fetchAndDisplayEmails(true, false);       // Immediate silent Gmail sync
        await fetchRedmineIssues(false);
        await loadOpenTickets(true);

        // Controllo deep-link email condivisa
        const urlParams = new URLSearchParams(window.location.search);
        const sharedEmailId = urlParams.get('emailId');
        if (sharedEmailId) {
            // Rimuove il parametro dall'URL senza ricaricare la pagina per pulizia
            const newUrl = window.location.pathname;
            window.history.replaceState({}, document.title, newUrl);
            
            try {
                const res = await fetch(`/api/emails/${sharedEmailId}`);
                if (res.ok) {
                    const email = await res.json();
                    openFullScreenEmail(email, true);
                } else {
                    showToast("Impossibile caricare l'email condivisa o sessione non valida.", "error");
                }
            } catch (err) {
                console.error("Errore nel recupero dell'email condivisa:", err);
            }
        }
    })();

    // Inizializza e imposta polling utenti attivi ogni 15 secondi
    fetchAndDisplayActiveUsers();
    setInterval(fetchAndDisplayActiveUsers, 15000);

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

    const easyMDE = new EasyMDE({ element: noteContent, autoDownloadFontAwesome: false });

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

    // --- Layout, Drag-and-Drop, Attachments and Resizer State ---
    let replyModalState = 'normal'; // 'normal', 'fullscreen', 'floating'
    let replyAttachments = [];
    let targetImage = null;
    let imageResizeOverlay = null;

    const replyFloatingBtn = document.getElementById('reply-floating-btn');
    const replyFullscreenBtn = document.getElementById('reply-fullscreen-btn');

    if (replyFloatingBtn) {
        replyFloatingBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (replyModalState === 'floating') {
                setReplyModalState('normal');
            } else {
                setReplyModalState('floating');
            }
        });
    }

    if (replyFullscreenBtn) {
        replyFullscreenBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (replyModalState === 'fullscreen') {
                setReplyModalState('normal');
            } else {
                setReplyModalState('fullscreen');
            }
        });
    }

    function setReplyModalState(newState) {
        const dialog = replyModalEl.querySelector('.modal-dialog');
        const backdropEl = document.querySelector('.modal-backdrop');
        const header = replyModalEl.querySelector('.modal-header');
        
        // Clear previous state classes/styles
        replyModalEl.classList.remove('reply-window-floating');
        dialog.classList.remove('modal-fullscreen');
        
        // Reset manual inline styles
        replyModalEl.style.position = '';
        replyModalEl.style.top = '';
        replyModalEl.style.left = '';
        replyModalEl.style.bottom = '';
        replyModalEl.style.right = '';
        replyModalEl.style.width = '';
        replyModalEl.style.height = '';
        replyModalEl.style.pointerEvents = '';
        replyModalEl.style.overflow = '';
        dialog.style.pointerEvents = '';
        header.style.cursor = '';
        
        document.body.classList.add('modal-open');
        if (backdropEl) backdropEl.classList.remove('d-none');
        
        // Clean up dragging listener
        header.onmousedown = null;

        replyModalState = newState;

        const floatBtn = document.getElementById('reply-floating-btn');
        const fullBtn = document.getElementById('reply-fullscreen-btn');

        // Apply new state
        if (newState === 'fullscreen') {
            dialog.classList.add('modal-fullscreen');
            if (fullBtn) fullBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
            if (floatBtn) floatBtn.innerHTML = '<i class="fa-solid fa-window-restore"></i>';
        } else if (newState === 'floating') {
            replyModalEl.classList.add('reply-window-floating');
            
            // Set initial float position at bottom right
            const initialWidth = 650;
            const initialHeight = 600;
            replyModalEl.style.width = initialWidth + 'px';
            replyModalEl.style.height = initialHeight + 'px';
            replyModalEl.style.top = Math.max(20, window.innerHeight - initialHeight - 20) + 'px';
            replyModalEl.style.left = Math.max(20, window.innerWidth - initialWidth - 20) + 'px';
            replyModalEl.style.bottom = 'auto';
            replyModalEl.style.right = 'auto';
            
            // Disable backdrop
            if (backdropEl) backdropEl.classList.add('d-none');
            document.body.classList.remove('modal-open');
            
            // Make draggable
            makeElementDraggable(replyModalEl, header);
            
            if (fullBtn) fullBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
            if (floatBtn) floatBtn.innerHTML = '<i class="fa-solid fa-window-maximize"></i>';
        } else {
            // Normal mode
            if (fullBtn) fullBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
            if (floatBtn) floatBtn.innerHTML = '<i class="fa-solid fa-window-restore"></i>';
        }
        
        updateResizeOverlayPosition();
    }

    function makeElementDraggable(dragEl, handleEl) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        handleEl.style.cursor = 'move';
        handleEl.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
            if (e.button !== 0) return;
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a') || e.target.closest('span')) return;

            e = e || window.event;
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            
            let newTop = dragEl.offsetTop - pos2;
            let newLeft = dragEl.offsetLeft - pos1;

            const maxLeft = window.innerWidth - dragEl.clientWidth;
            const maxTop = window.innerHeight - dragEl.clientHeight;

            if (newLeft < 0) newLeft = 0;
            if (newTop < 0) newTop = 0;
            if (newLeft > maxLeft) newLeft = maxLeft;
            if (newTop > maxTop) newTop = maxTop;

            dragEl.style.top = newTop + "px";
            dragEl.style.left = newLeft + "px";
            dragEl.style.bottom = "auto";
            dragEl.style.right = "auto";
            
            updateResizeOverlayPosition();
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    // --- File Attachments Logic ---
    const replyAddAttachmentBtn = document.getElementById('reply-add-attachment-btn');
    const replyFileInput = document.getElementById('reply-file-input');
    const replyAttachedFilesContainer = document.getElementById('reply-attached-files');
    const replyAttachmentInfo = document.getElementById('reply-attachment-info');

    function handleFiles(files) {
        if (!files || files.length === 0) return;

        Array.from(files).forEach(file => {
            const alreadyAdded = replyAttachments.some(att => att.filename === file.name && att.size === file.size);
            if (alreadyAdded) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                replyAttachments.push({
                    filename: file.name,
                    size: file.size,
                    content: event.target.result.split(',')[1],
                    contentType: file.type || 'application/octet-stream'
                });
                renderAttachments();
            };
            reader.readAsDataURL(file);
        });
    }

    if (replyAddAttachmentBtn && replyFileInput) {
        replyAddAttachmentBtn.addEventListener('click', (e) => {
            e.preventDefault();
            replyFileInput.click();
        });

        replyFileInput.addEventListener('change', (e) => {
            handleFiles(e.target.files);
            replyFileInput.value = '';
        });
    }

    // --- Drag and Drop for Attachments in Reply Modal ---
    const replyDragDropOverlay = document.createElement('div');
    replyDragDropOverlay.className = 'reply-drag-drop-overlay';
    replyDragDropOverlay.style.display = 'none';
    replyDragDropOverlay.innerHTML = `
        <div class="reply-drag-drop-overlay-content">
            <i class="fa-solid fa-cloud-arrow-up"></i>
            <span>Trascina qui i file per allegarli</span>
        </div>
    `;
    if (replyModalEl) {
        const replyModalContent = replyModalEl.querySelector('.modal-content');
        if (replyModalContent) {
            replyModalContent.style.position = 'relative';
            replyModalContent.appendChild(replyDragDropOverlay);
        }

        let dragCounter = 0;

        replyModalEl.addEventListener('dragenter', (e) => {
            e.preventDefault();
            if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
                dragCounter++;
                replyDragDropOverlay.style.display = 'flex';
            }
        });

        replyModalEl.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        replyModalEl.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                replyDragDropOverlay.style.display = 'none';
            }
        });

        replyModalEl.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            replyDragDropOverlay.style.display = 'none';

            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handleFiles(e.dataTransfer.files);
            }
        });
    }


    function renderAttachments() {
        if (!replyAttachedFilesContainer) return;
        replyAttachedFilesContainer.innerHTML = '';

        if (replyAttachments.length === 0) {
            if (replyAttachmentInfo) replyAttachmentInfo.textContent = 'Nessun file selezionato';
            return;
        }

        if (replyAttachmentInfo) {
            replyAttachmentInfo.textContent = `${replyAttachments.length} file selezionati`;
        }

        replyAttachments.forEach((att, index) => {
            const badge = document.createElement('span');
            badge.className = 'attached-file-badge';
            
            let icon = 'fa-file';
            if (att.contentType.startsWith('image/')) icon = 'fa-file-image';
            else if (att.contentType.includes('pdf')) icon = 'fa-file-pdf';
            else if (att.contentType.includes('word') || att.contentType.includes('office-document')) icon = 'fa-file-word';
            else if (att.contentType.includes('excel') || att.contentType.includes('spreadsheet')) icon = 'fa-file-excel';
            
            badge.innerHTML = `
                <i class="fa-solid ${icon}"></i>
                <span>${att.filename} (${formatFileSize(att.size)})</span>
                <button type="button" class="remove-attachment-btn" data-index="${index}">&times;</button>
            `;
            
            badge.querySelector('.remove-attachment-btn').onclick = (e) => {
                e.preventDefault();
                replyAttachments.splice(index, 1);
                renderAttachments();
            };

            replyAttachedFilesContainer.appendChild(badge);
        });
    }

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    // --- Image Resizer Utility Functions ---
    function initImageResizer() {
        if (document.getElementById('image-resize-overlay')) return;
        
        imageResizeOverlay = document.createElement('div');
        imageResizeOverlay.id = 'image-resize-overlay';
        imageResizeOverlay.style.display = 'none';
        imageResizeOverlay.innerHTML = `
            <div class="resize-handle bottom-right"></div>
            <div class="resize-toolbar">
                <button type="button" class="btn btn-xs btn-dark text-white resize-preset" data-pct="25">25%</button>
                <button type="button" class="btn btn-xs btn-dark text-white resize-preset" data-pct="50">50%</button>
                <button type="button" class="btn btn-xs btn-dark text-white resize-preset" data-pct="75">75%</button>
                <button type="button" class="btn btn-xs btn-dark text-white resize-preset" data-pct="100">100%</button>
                <button type="button" class="btn btn-xs btn-danger text-white resize-delete" title="Elimina immagine">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;
        document.body.appendChild(imageResizeOverlay);
        
        const handle = imageResizeOverlay.querySelector('.resize-handle');
        handle.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const startX = e.clientX;
            const startWidth = targetImage.clientWidth;
            
            document.onmousemove = (moveEvent) => {
                const deltaX = moveEvent.clientX - startX;
                let newWidth = startWidth + deltaX;
                
                if (newWidth < 50) newWidth = 50;
                
                targetImage.style.width = newWidth + 'px';
                targetImage.style.height = 'auto';
                
                updateResizeOverlayPosition();
            };
            
            document.onmouseup = () => {
                document.onmousemove = null;
                document.onmouseup = null;
                const editor = document.getElementById('reply-body-rich');
                const hiddenTextarea = document.getElementById('reply-body');
                if (editor && hiddenTextarea) {
                    hiddenTextarea.value = editor.innerHTML;
                }
            };
        };
        
        imageResizeOverlay.querySelectorAll('.resize-preset').forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const pct = btn.dataset.pct;
                targetImage.style.width = pct + '%';
                targetImage.style.height = 'auto';
                updateResizeOverlayPosition();
                
                const editor = document.getElementById('reply-body-rich');
                const hiddenTextarea = document.getElementById('reply-body');
                if (editor && hiddenTextarea) {
                    hiddenTextarea.value = editor.innerHTML;
                }
            };
        });
        
        imageResizeOverlay.querySelector('.resize-delete').onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (targetImage) {
                targetImage.remove();
                imageResizeOverlay.style.display = 'none';
                targetImage = null;
                
                const editor = document.getElementById('reply-body-rich');
                const hiddenTextarea = document.getElementById('reply-body');
                if (editor && hiddenTextarea) {
                    hiddenTextarea.value = editor.innerHTML;
                }
            }
        };
        
        const editor = document.getElementById('reply-body-rich');
        if (editor) {
            editor.addEventListener('scroll', updateResizeOverlayPosition);
            editor.addEventListener('click', (e) => {
                if (e.target.tagName === 'IMG') {
                    e.stopPropagation();
                    targetImage = e.target;
                    updateResizeOverlayPosition();
                    imageResizeOverlay.style.display = 'block';
                }
            });
        }
        
        window.addEventListener('resize', updateResizeOverlayPosition);
        document.addEventListener('scroll', updateResizeOverlayPosition, true);
        
        document.addEventListener('click', (e) => {
            if (targetImage && e.target !== targetImage && !imageResizeOverlay.contains(e.target)) {
                imageResizeOverlay.style.display = 'none';
                targetImage = null;
            }
        });
    }

    function updateResizeOverlayPosition() {
        if (!targetImage || !imageResizeOverlay || imageResizeOverlay.style.display === 'none') return;
        const rect = targetImage.getBoundingClientRect();
        imageResizeOverlay.style.top = (rect.top + window.scrollY) + 'px';
        imageResizeOverlay.style.left = (rect.left + window.scrollX) + 'px';
        imageResizeOverlay.style.width = rect.width + 'px';
        imageResizeOverlay.style.height = rect.height + 'px';
    }

    const toggleCcBtn = document.getElementById('toggle-cc-btn');
    const toggleBccBtn = document.getElementById('toggle-bcc-btn');
    const ccFieldGroup = document.getElementById('cc-field-group');
    const bccFieldGroup = document.getElementById('bcc-field-group');

    if (toggleCcBtn && ccFieldGroup) {
        toggleCcBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (ccFieldGroup.style.display === 'none') {
                ccFieldGroup.style.display = 'block';
                toggleCcBtn.textContent = '- Cc';
            } else {
                ccFieldGroup.style.display = 'none';
                toggleCcBtn.textContent = '+ Cc';
            }
        });
    }

    if (toggleBccBtn && bccFieldGroup) {
        toggleBccBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (bccFieldGroup.style.display === 'none') {
                bccFieldGroup.style.display = 'block';
                toggleBccBtn.textContent = '- Ccn';
            } else {
                bccFieldGroup.style.display = 'none';
                toggleBccBtn.textContent = '+ Ccn';
            }
        });
    }

    // --- Advanced Email Editor Helpers & Setup ---
    function getSignatureHTML(isPersonal = true) {
        const subtitle = (isPersonal && currentUsername) ? formatUsername(currentUsername) : 'Helpdesk & Support';

        return `<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr"><table style="color:rgb(34,34,34); font-family: 'Poppins', sans-serif; font-size: 13px;"><tbody><tr><td style="vertical-align:top;width:255px;padding-right:15px;"><img src="https://ci3.googleusercontent.com/meips/ADKq_NakdLZw3np14DEPBZOPt2kQWv8lxgVYYYdEt65x_rbukNuIdC4HZfnoOm2NiE8CGuDKVV-wJ-skUokO8lQ4OsFbCfFRxHEwO2BPw2BJNkh1uBwJiA=s0-d-e1-ft#http://www.maestrale.it/email-sign/logo-maestrale_MIT.png?10=0" class="CToWUd" data-bit="iit" style="max-width:100%; height:auto;"></td><td><p style="margin-bottom:0px;padding-bottom:0px"><span style="color:rgb(0,79,152);font-size:14px"><b>Support Team<br></b></span><span class="sig-user-title-text" style="color:rgb(102,102,102);font-size:13px">${subtitle}</span></p><p style="font-size:12px; margin: 5px 0;"></p><h2 style="font-size:12px;margin-bottom:0px;padding-bottom:0px;color:rgb(84,4,9)"><b>MAESTRALE INFORMATION TECHNOLOGY</b></h2><p style="font-size:11px;margin-bottom:0px;padding-bottom:0px;padding-top:0px;margin-top:0px;line-height:1.4;"><span style="color:rgb(84,4,9)"><b>a</b></span><font color="#666666">&nbsp;Via Luigi Casale 7 - 05100 Terni (Italy)<br></font><span style="color:rgb(84,4,9)"><b>t</b></span>&nbsp;<span style="color:rgb(102,102,102)">0744 436225&nbsp;</span><span style="color:rgb(84,4,9)"><b>&nbsp;f</b></span>&nbsp;<font color="#666666">0744 431944<br></font><span style="color:rgb(84,4,9)"><b>w</b></span>&nbsp;<a href="http://www.maestrale.it/" style="color:rgb(102,102,102)" target="_blank" data-saferedirecturl="https://www.google.com/url?q=http://www.maestrale.it/&amp;source=gmail&amp;ust=1779542067182000&amp;usg=AOvVaw2Sya1JNjp2mh02JAhZL0lW">www.maestrale.it</a>&nbsp;</p><p style="margin-top: 5px;"><a href="https://www.facebook.com/gruppomaestrale" style="color:rgb(17,85,204)" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://www.facebook.com/gruppomaestrale&amp;source=gmail&amp;ust=1779542067182000&amp;usg=AOvVaw0L23XSoCEifgk1SEYeH7TF"><img src="https://ci3.googleusercontent.com/meips/ADKq_NaKfK3L8yY6uScfZvTGUl6UZVZAodJOrywf70NsRPvIkI3mVr9con35lKMUf2XAOnUkCnVhKYRGOz6Jg-0r5THm2Ys5yqofaiwz=s0-d-e1-ft#http://www.maestrale.it/email-sign/social/fb.png?1=0" class="CToWUd" data-bit="iit"></a>&nbsp;<a href="https://twitter.com/GruppoMaestrale" style="color:rgb(17,85,204)" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://twitter.com/GruppoMaestrale&amp;source=gmail&amp;ust=1779542067182000&amp;usg=AOvVaw1QsWwpEWFCe-L7yd0poTVu"><img src="https://ci3.googleusercontent.com/meips/ADKq_NbQs_27dZpcSzDtedkgh3etCgrQ9w_2srSGaS9S4JAIUhxbb4j9D76NBKs3njlYbMWcxhWGS7071R3jQMYINo9mo_KjWuw2CqLM=s0-d-e1-ft#http://www.maestrale.it/email-sign/social/tw.png?1=0" class="CToWUd" data-bit="iit"></a>&nbsp;<a href="https://www.linkedin.com/company/9210389/admin/" style="color:rgb(17,85,204)" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://www.linkedin.com/company/9210389/admin/&amp;source=gmail&amp;ust=1779542067182000&amp;usg=AOvVaw1g5N3UPSXhJaXs8DdCu1Gf"><img src="https://ci3.googleusercontent.com/meips/ADKq_NZSOZLZuGUxuF0OgfnrOt2Y6OF9UAdHWuUJWpb4FeaDX9zDXg2wxXmVKtWwLCBhQHt_Fdb_247YCsgL6QamEw3enmTnfSfIVH02=s0-d-e1-ft#http://www.maestrale.it/email-sign/social/li.png?1=0" class="CToWUd" data-bit="iit"></a>&nbsp;<a href="https://www.youtube.com/channel/UCEg5aHL5mKonU_JbA0pJXhw?view_as=subscriber" style="color:rgb(17,85,204)" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://www.youtube.com/channel/UCEg5aHL5mKonU_JbA0pJXhw?view_as%3Dsubscriber&amp;source=gmail&amp;ust=1779542067182000&amp;usg=AOvVaw3pZPfEJPBGA5MuMyVf9rNC"><img src="https://ci3.googleusercontent.com/meips/ADKq_NavDnRe5qkEexXOJFYfrZsVdMouNpEXiQQnhzt_iuCzSsJ2RMIOUvbwbGUrDMWiDeZuQ_tYytD2WYh657vjWvyA6bzAvGXS0rfD=s0-d-e1-ft#http://www.maestrale.it/email-sign/social/yt.png?1=0" class="CToWUd" data-bit="iit"></a></p></td></tr></tbody></table></div></div>`;
    }

    function formatUsername(uname) {
        if (!uname) return 'Helpdesk & Support';
        return uname
            .split('.')
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    function initRichTextEditor() {
        if (isRichTextEditorInitialized) return;
        isRichTextEditorInitialized = true;

        const editor = document.getElementById('reply-body-rich');
        const hiddenTextarea = document.getElementById('reply-body');
        const toolbar = document.getElementById('rich-text-toolbar');
        const toggleFormattingBtn = document.getElementById('toggle-formatting-btn');
        const firmatiBtn = document.getElementById('firmati-btn');
        
        if (!editor) return;

        initImageResizer();

        // Toggle Formatting Toolbar
        if (toggleFormattingBtn && toolbar) {
            // Sostituisce l'event listener precedente se già presente o ne registra uno nuovo
            toggleFormattingBtn.onclick = (e) => {
                e.preventDefault();
                if (toolbar.style.display === 'none') {
                    toolbar.style.display = 'flex';
                } else {
                    toolbar.style.display = 'none';
                }
            };
        }

        // Standard commands
        const toolbarBtns = toolbar.querySelectorAll('.toolbar-btn[data-command]');
        toolbarBtns.forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                const command = btn.dataset.command;
                document.execCommand(command, false, null);
                editor.focus();
                updateToolbarState();
            };
        });

        // Font Family Selection
        const fontSelect = document.getElementById('editor-font');
        if (fontSelect) {
            fontSelect.onchange = () => {
                document.execCommand('fontName', false, fontSelect.value);
                editor.focus();
            };
        }

        // Font Size Selection
        const sizeSelect = document.getElementById('editor-size');
        if (sizeSelect) {
            sizeSelect.onchange = () => {
                document.execCommand('fontSize', false, sizeSelect.value);
                editor.focus();
            };
        }

        // Insert Link
        const linkBtn = document.getElementById('editor-link-btn');
        if (linkBtn) {
            linkBtn.onclick = (e) => {
                e.preventDefault();
                const url = prompt('Inserisci l\'URL del link:');
                if (url) {
                    document.execCommand('createLink', false, url);
                    editor.focus();
                }
            };
        }

        // Color Palettes
        const colors = [
            '#000000', '#434343', '#666666', '#999999', '#cccccc', '#efefef', '#f3f3f3', '#ffffff',
            '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#9fc5e8', '#b4a7d6', '#d5a6bd',
            '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6fa8dc', '#8e7cc3', '#c27ba0',
            '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3d85c6', '#674ea7', '#a64d79',
            '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#0b5394', '#351c75', '#741b47'
        ];

        const textPalette = document.getElementById('text-color-palette');
        const bgPalette = document.getElementById('bg-color-palette');
        const textIndicator = document.getElementById('text-color-indicator');
        const bgIndicator = document.getElementById('bg-color-indicator');

        function generatePalette(container, isBackground) {
            if (!container) return;
            container.innerHTML = '';
            colors.forEach(color => {
                const swatch = document.createElement('div');
                swatch.className = 'color-swatch';
                swatch.style.backgroundColor = color;
                swatch.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isBackground) {
                        document.execCommand('hiliteColor', false, color);
                        if (bgIndicator) bgIndicator.style.backgroundColor = color;
                    } else {
                        document.execCommand('foreColor', false, color);
                        if (textIndicator) textIndicator.style.backgroundColor = color;
                    }
                    container.classList.remove('show');
                    editor.focus();
                };
                container.appendChild(swatch);
            });
        }

        generatePalette(textPalette, false);
        generatePalette(bgPalette, true);

        const textColorBtn = document.getElementById('text-color-btn');
        if (textColorBtn) {
            textColorBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (bgPalette) bgPalette.classList.remove('show');
                if (textPalette) textPalette.classList.toggle('show');
            };
        }

        const bgColorBtn = document.getElementById('bg-color-btn');
        if (bgColorBtn) {
            bgColorBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (textPalette) textPalette.classList.remove('show');
                if (bgPalette) bgPalette.classList.toggle('show');
            };
        }

        // Close palettes on click outside
        document.addEventListener('click', () => {
            if (textPalette) textPalette.classList.remove('show');
            if (bgPalette) bgPalette.classList.remove('show');
        });

        // Sync with hidden textarea on inputs
        editor.oninput = () => {
            if (hiddenTextarea) hiddenTextarea.value = editor.innerHTML;
        };

        editor.onkeyup = updateToolbarState;
        editor.onmouseup = updateToolbarState;

        function updateToolbarState() {
            const commands = ['bold', 'italic', 'underline', 'strikeThrough'];
            commands.forEach(cmd => {
                const btn = toolbar.querySelector(`.toolbar-btn[data-command="${cmd}"]`);
                if (btn) {
                    if (document.queryCommandState(cmd)) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                }
            });
        }

        // --- "Firmati" Toggling Feature ---
        if (firmatiBtn) {
            firmatiBtn.onclick = (e) => {
                e.preventDefault();
                
                // Target ONLY the active signature block in the editor to avoid affecting quotes in thread history
                const activeSig = editor.querySelector('.gmail_signature:not(blockquote .gmail_signature)');
                if (activeSig) {
                    const sigTitleEls = activeSig.querySelectorAll('.sig-user-title-text');
                    const formattedName = formatUsername(currentUsername);
                    
                    sigTitleEls.forEach(el => {
                        const currentVal = el.textContent.trim();
                        if (currentVal === formattedName) {
                            el.textContent = 'Helpdesk & Support';
                            firmatiBtn.classList.remove('btn-primary');
                            firmatiBtn.classList.add('btn-outline-primary');
                        } else {
                            el.textContent = formattedName;
                            firmatiBtn.classList.remove('btn-outline-primary');
                            firmatiBtn.classList.add('btn-primary');
                        }
                    });
                    
                    // Trigger input event to synchronize the updated html content to the hidden textarea
                    editor.dispatchEvent(new Event('input'));
                }
            };
        }
    }

    async function openReplyModal(email, isReplyAll = false) {
        if (!email || !replyModalEl) return;

        if (!email.body && !email.bodyHtml) {
            try {
                const res = await fetch(`/api/emails/${email.id}`);
                if (!res.ok) throw new Error('Errore di rete');
                const fullEmail = await res.json();
                Object.assign(email, fullEmail);
            } catch (err) {
                console.error(err);
                alert("Impossibile caricare i dettagli dell'email per la risposta: " + err.message);
                return;
            }
        }

        loadContacts();
        replyAttachments = [];
        renderAttachments();
        setReplyModalState('normal');

        // Reset title
        replyModalEl.querySelector('#replyModalLabel').textContent = isReplyAll ? 'Rispondi a Tutti' : 'Rispondi all\'Email';

        // Helper to parse recipients
        function parseRecipientsList(fieldValue) {
            if (!fieldValue) return [];
            const results = [];
            const parts = fieldValue.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g);
            for (let part of parts) {
                part = part.trim();
                if (!part) continue;
                const emailMatch = part.match(/<([^>]+)>/) || [null, part];
                const emailAddr = emailMatch[1] ? emailMatch[1].trim() : part;
                let name = part.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
                if (!name) name = emailAddr;
                results.push({ name, email: emailAddr });
            }
            return results;
        }

        let replyTo = email.from;
        let replyCc = [];

        if (isReplyAll) {
            const fromRecipients = parseRecipientsList(email.from);
            const toRecipients = parseRecipientsList(email.to);
            const ccRecipients = parseRecipientsList(email.cc);

            const userEmailLower = accountEmail ? accountEmail.toLowerCase().trim() : '';

            let mainReplyEmail = '';
            if (fromRecipients.length > 0) {
                const firstFrom = fromRecipients[0].email.toLowerCase().trim();
                if (userEmailLower && firstFrom === userEmailLower) {
                    // Sent by me, so reply to the original To recipients
                    if (toRecipients.length > 0) {
                        replyTo = email.to;
                        mainReplyEmail = toRecipients[0].email.toLowerCase().trim();
                    } else {
                        replyTo = email.from;
                    }
                } else {
                    replyTo = email.from;
                    mainReplyEmail = firstFrom;
                }
            } else {
                replyTo = email.from;
            }

            const allRecipients = [...fromRecipients, ...toRecipients, ...ccRecipients];
            const addedEmails = new Set();
            
            if (mainReplyEmail) addedEmails.add(mainReplyEmail);
            
            const replyToParsed = parseRecipientsList(replyTo);
            replyToParsed.forEach(r => addedEmails.add(r.email.toLowerCase().trim()));

            if (userEmailLower) {
                addedEmails.add(userEmailLower);
            }

            allRecipients.forEach(r => {
                const emailLower = r.email.toLowerCase().trim();
                if (!addedEmails.has(emailLower)) {
                    addedEmails.add(emailLower);
                    const formatted = r.name && r.name !== r.email ? `"${r.name}" <${r.email}>` : r.email;
                    replyCc.push(formatted);
                }
            });
        }

        // Populate the modal fields
        replyModalEl.querySelector('#reply-to').value = replyTo;
        const subjectField = replyModalEl.querySelector('#reply-subject');
        subjectField.value = email.subject.startsWith('Re: ') ? email.subject : `Re: ${email.subject}`;

        // Reset CC/BCC inputs
        if (ccFieldGroup) {
            if (isReplyAll && replyCc.length > 0) {
                ccFieldGroup.style.display = 'block';
                ccFieldGroup.querySelector('#reply-cc').value = replyCc.join(', ');
                toggleCcBtn.textContent = '- Cc';
            } else {
                ccFieldGroup.style.display = 'none';
                ccFieldGroup.querySelector('#reply-cc').value = '';
                toggleCcBtn.textContent = '+ Cc';
            }
        }
        if (bccFieldGroup) {
            bccFieldGroup.style.display = 'none';
            bccFieldGroup.querySelector('#reply-bcc').value = '';
            toggleBccBtn.textContent = '+ Ccn';
        }

        // Inizializza l'editor rich text avanzato
        const editor = document.getElementById('reply-body-rich');
        if (editor) {
            let quotedHTML = '';
            if (email.bodyHtml) {
                const processedHtml = replaceCidsWithBase64(email.bodyHtml, email);
                quotedHTML = `<br><br><blockquote class="gmail_quote" style="margin: 0px 0px 0px 0.8ex; border-left: 2px solid #ccc; padding-left: 1ex;">
                    <div style="font-family: inherit; font-size: inherit;">
                        ${processedHtml}
                    </div>
                </blockquote>`;
            } else {
                const quotedText = (email.body || '').split('\n').map(line => `> ${line}`).join('<br>');
                quotedHTML = `<br><br><blockquote class="gmail_quote" style="margin: 0px 0px 0px 0.8ex; border-left: 2px solid #ccc; padding-left: 1ex;">
                    ${quotedText}
                </blockquote>`;
            }

            editor.innerHTML = `<div><br></div><div><br></div>${getSignatureHTML(false)}${quotedHTML}`;
            
            // Sync with hidden textarea
            document.getElementById('reply-body').value = editor.innerHTML;
        }

        // Reset the "Firmati" button state
        const firmatiBtn = document.getElementById('firmati-btn');
        if (firmatiBtn) {
            firmatiBtn.classList.remove('btn-primary');
            firmatiBtn.classList.add('btn-outline-primary');
        }

        // Pass the email ID to the send button
        sendReplyBtn.dataset.originalMessageId = email.id;
        sendReplyBtn.dataset.actionType = 'reply';

        // Manually show the modal
        document.body.classList.add('modal-open');
        replyModalEl.style.display = 'block';
        replyModalEl.classList.add('show');
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop fade show';
        document.body.appendChild(backdrop);

        // Inizializza comandi ed editor, e posiziona il cursore
        initRichTextEditor();
        if (editor) {
            setTimeout(() => {
                editor.focus();
                const range = document.createRange();
                const sel = window.getSelection();
                if (editor.firstChild) {
                    range.setStart(editor.firstChild, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }, 100);
        }
    }

    async function openForwardModal(email) {
        if (!email || !replyModalEl) return;

        if (!email.body && !email.bodyHtml) {
            try {
                const res = await fetch(`/api/emails/${email.id}`);
                if (!res.ok) throw new Error('Errore di rete');
                const fullEmail = await res.json();
                Object.assign(email, fullEmail);
            } catch (err) {
                console.error(err);
                alert("Impossibile caricare i dettagli dell'email per l'inoltro: " + err.message);
                return;
            }
        }

        loadContacts();
        replyAttachments = [];
        renderAttachments();
        setReplyModalState('normal');

        // Reset title
        replyModalEl.querySelector('#replyModalLabel').textContent = 'Inoltra l\'Email';

        // Clear and enable To field
        replyModalEl.querySelector('#reply-to').value = '';

        // Populate the Subject
        const subjectField = replyModalEl.querySelector('#reply-subject');
        subjectField.value = email.subject.startsWith('Fwd: ') ? email.subject : `Fwd: ${email.subject}`;

        // Reset CC/BCC inputs
        if (ccFieldGroup) {
            ccFieldGroup.style.display = 'none';
            ccFieldGroup.querySelector('#reply-cc').value = '';
            toggleCcBtn.textContent = '+ Cc';
        }
        if (bccFieldGroup) {
            bccFieldGroup.style.display = 'none';
            bccFieldGroup.querySelector('#reply-bcc').value = '';
            toggleBccBtn.textContent = '+ Ccn';
        }

        // Inizializza l'editor rich text per l'inoltro
        const editor = document.getElementById('reply-body-rich');
        if (editor) {
            const dateStr = new Date(parseInt(email.internalDate, 10)).toLocaleString('it-IT');
            const forwardHeader = `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 13px;">
                <br><br>
                ---------- Forwarded message ---------<br>
                <b>Da:</b> ${email.from}<br>
                <b>Data:</b> ${dateStr}<br>
                <b>Oggetto:</b> ${email.subject}<br>
                <b>A:</b> ${email.to || ''}<br>
                <br>
            </div>`;
            
            let originalContentHTML = '';
            if (email.bodyHtml) {
                originalContentHTML = replaceCidsWithBase64(email.bodyHtml, email);
            } else {
                originalContentHTML = (email.body || '').replace(/\n/g, '<br>');
            }

            editor.innerHTML = `<div><br></div><div><br></div>${getSignatureHTML(false)}${forwardHeader}${originalContentHTML}`;
            
            // Sync with hidden textarea
            document.getElementById('reply-body').value = editor.innerHTML;
        }

        // Reset the "Firmati" button state
        const firmatiBtn = document.getElementById('firmati-btn');
        if (firmatiBtn) {
            firmatiBtn.classList.remove('btn-primary');
            firmatiBtn.classList.add('btn-outline-primary');
        }

        // Pass the email ID to the send button
        sendReplyBtn.dataset.originalMessageId = email.id;
        sendReplyBtn.dataset.actionType = 'forward';

        // Manually show the modal
        document.body.classList.add('modal-open');
        replyModalEl.style.display = 'block';
        replyModalEl.classList.add('show');
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop fade show';
        document.body.appendChild(backdrop);

        // Inizializza comandi ed editor, e posiziona il cursore
        initRichTextEditor();
        if (editor) {
            setTimeout(() => {
                editor.focus();
                const range = document.createRange();
                const sel = window.getSelection();
                if (editor.firstChild) {
                    range.setStart(editor.firstChild, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }, 100);
        }
    }

    function closeReplyModal() {
        if (!replyModalEl) return;

        setReplyModalState('normal');

        // Manually hide the modal
        document.body.classList.remove('modal-open');
        replyModalEl.style.display = 'none';
        replyModalEl.classList.remove('show');
        const backdrop = document.querySelector('.modal-backdrop');
        if (backdrop) {
            backdrop.remove();
        }

        // Hide image resizer overlay if open
        if (imageResizeOverlay) {
            imageResizeOverlay.style.display = 'none';
            targetImage = null;
        }

        replyAttachments = [];
        renderAttachments();
    }

    // --- Application Version Logic ---
    async function loadAppVersion() {
        try {
            const response = await fetch('/api/version');
            if (response.ok) {
                const data = await response.json();
                const verSpan = document.getElementById('app-version');
                if (verSpan && data.version) {
                    verSpan.textContent = `v${data.version}`;
                }
            }
        } catch (err) {
            console.error('Errore caricamento versione:', err);
        }
    }

    // --- Autocomplete Recipient Suggestions Logic ---
    async function loadContacts() {
        try {
            const response = await fetch('/api/contacts');
            if (response.ok) {
                const data = await response.json();
                contactsList = data.contacts || [];
            }
        } catch (err) {
            console.error('Errore caricamento contatti:', err);
        }
    }

    function renderContactSuggestions(inputEl, autocompleteListEl, suggestions) {
        autocompleteListEl.innerHTML = '';
        
        if (suggestions.length === 0) {
            autocompleteListEl.style.display = 'none';
            return;
        }
        
        const limit = 10;
        const visibleSuggestions = suggestions.slice(0, limit);
        
        visibleSuggestions.forEach(suggestion => {
            const item = document.createElement('div');
            item.className = 'autocomplete-suggestion-item';
            
            const email = suggestion;
            const namePart = email.split('@')[0];
            let displayName = email;
            if (namePart.includes('.')) {
                const nameFormatted = namePart.split('.')
                    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
                    .join(' ');
                displayName = `${nameFormatted} &lt;${email}&gt;`;
            }
            
            item.innerHTML = `<span class="suggestion-title">${displayName}</span>`;
            
            item.addEventListener('click', () => {
                const parts = inputEl.value.split(',');
                parts[parts.length - 1] = ' ' + email;
                inputEl.value = parts.join(',').trim() + ', ';
                autocompleteListEl.style.display = 'none';
                inputEl.focus();
            });
            
            autocompleteListEl.appendChild(item);
        });
        
        autocompleteListEl.style.display = 'block';
    }

    function setupEmailAutocomplete(inputId, listId) {
        const inputEl = document.getElementById(inputId);
        const listEl = document.getElementById(listId);
        if (!inputEl || !listEl) return;
        
        inputEl.addEventListener('input', () => {
            const value = inputEl.value;
            const parts = value.split(',');
            const currentToken = parts[parts.length - 1].trim();
            
            if (!currentToken) {
                listEl.innerHTML = '';
                listEl.style.display = 'none';
                return;
            }
            
            const query = currentToken.toLowerCase();
            const existingEmails = parts.slice(0, -1).map(p => p.trim().toLowerCase());
            const filtered = contactsList.filter(contact => {
                const contactLower = contact.toLowerCase();
                return contactLower.includes(query) && !existingEmails.includes(contactLower);
            });
            
            renderContactSuggestions(inputEl, listEl, filtered);
        });

        // Close on escape key
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                listEl.style.display = 'none';
            }
        });
    }

    // Initialize autocomplete for To, Cc, Bcc
    setupEmailAutocomplete('reply-to', 'reply-to-autocomplete-list');
    setupEmailAutocomplete('reply-cc', 'reply-cc-autocomplete-list');
    setupEmailAutocomplete('reply-bcc', 'reply-bcc-autocomplete-list');

    // Close suggestion lists on click outside
    document.addEventListener('click', (e) => {
        const toInput = document.getElementById('reply-to');
        const toList = document.getElementById('reply-to-autocomplete-list');
        const ccInput = document.getElementById('reply-cc');
        const ccList = document.getElementById('reply-cc-autocomplete-list');
        const bccInput = document.getElementById('reply-bcc');
        const bccList = document.getElementById('reply-bcc-autocomplete-list');

        if (toList && toInput && e.target !== toInput && !toList.contains(e.target)) {
            toList.style.display = 'none';
        }
        if (ccList && ccInput && e.target !== ccInput && !ccList.contains(e.target)) {
            ccList.style.display = 'none';
        }
        if (bccList && bccInput && e.target !== bccInput && !bccList.contains(e.target)) {
            bccList.style.display = 'none';
        }
    });

    // Listener for the send button
    sendReplyBtn.addEventListener('click', async () => {
        const originalMessageId = sendReplyBtn.dataset.originalMessageId;
        const actionType = sendReplyBtn.dataset.actionType;
        const isForward = actionType === 'forward';

        // Explicitly sync rich-text content to the hidden textarea before sending
        const richEditor = document.getElementById('reply-body-rich');
        const hiddenTextarea = document.getElementById('reply-body');
        if (richEditor && hiddenTextarea) {
            hiddenTextarea.value = richEditor.innerHTML;
        }

        const replyText = document.getElementById('reply-body').value;
        const to = document.getElementById('reply-to').value;
        const subject = document.getElementById('reply-subject').value;
        const cc = document.getElementById('reply-cc').value;
        const bcc = document.getElementById('reply-bcc').value;

        if (!to.trim()) {
            alert('A: (To) field cannot be empty.');
            return;
        }

        if (!replyText.trim()) {
            alert('Message cannot be empty.');
            return;
        }

        try {
            const response = await fetch('/api/send-reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ originalMessageId, replyText, to, subject, cc, bcc, isForward, attachments: replyAttachments })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Failed to send email.');
            }

            const result = await response.json();
            alert(result.message);
            closeReplyModal();

            // Chiede se segnare l'email originale come letta
            const markAsRead = confirm("Email inviata con successo. Vuoi segnare l'email originale come letta?");
            if (markAsRead) {
                const relatedIds = [];
                const origEmail = allEmails.find(e => e.id === originalMessageId);
                if (origEmail) {
                    const threadId = origEmail.threadId;
                    const subject = origEmail.subject;
                    allEmails.forEach(e => {
                        if ((threadId && e.threadId === threadId) || (!threadId && subject && e.subject === subject) || e.id === originalMessageId) {
                            if (!relatedIds.includes(e.id)) {
                                relatedIds.push(e.id);
                            }
                        }
                    });
                } else {
                    relatedIds.push(originalMessageId);
                }

                markVisualAsRead(relatedIds);

                try {
                    const readResponse = await fetch('/api/mark-as-read', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ emailIds: [originalMessageId] })
                    });
                    if (readResponse.ok) {
                        // Clean up localStorage
                        let savedPinnedIds = [];
                        try {
                            savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
                        } catch (e) {}
                        savedPinnedIds = savedPinnedIds.filter(id => !relatedIds.includes(id));
                        localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));

                        let unpinnedIds = [];
                        try {
                            unpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
                        } catch (e) {}
                        relatedIds.forEach(id => {
                            if (!unpinnedIds.includes(id)) {
                                unpinnedIds.push(id);
                            }
                        });
                        localStorage.setItem('explicitly_unpinned_email_ids', JSON.stringify(unpinnedIds));

                        // Filter and rerender
                        allEmails = allEmails.filter(e => !relatedIds.includes(e.id));
                        rerenderEmails();
                    } else {
                        unmarkVisualAsRead(relatedIds);
                    }
                } catch (readErr) {
                    console.error('Errore durante la marcatura come letta:', readErr);
                    unmarkVisualAsRead(relatedIds);
                }
            }
            if (typeof fetchAndDisplayEmails === 'function') {
                fetchAndDisplayEmails(true);
            }

        } catch (error) {
            console.error('Error sending email:', error);
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

    // --- GRAND WELCOME & SHEPHERD TOUR ---
    function startGrandWelcome() {
        const welcomeScreen = document.getElementById('grand-welcome-screen');
        const title = document.getElementById('welcome-title');
        const subtitle = document.getElementById('welcome-subtitle');

        if (!welcomeScreen || !title || !subtitle) return;

        welcomeScreen.style.display = 'flex';
        
        // Sequence of texts
        setTimeout(() => {
            title.textContent = 'Benvenuto.';
            subtitle.textContent = '';
            title.classList.add('show');
        }, 500);

        setTimeout(() => {
            welcomeScreen.classList.add('fade-out');
            setTimeout(() => {
                welcomeScreen.style.display = 'none';
                startShepherdTour();
            }, 1500); // match transition duration
        }, 2500);
    }

    function startShepherdTour() {
        if (typeof Shepherd === 'undefined') {
            console.error('Shepherd.js non è caricato.');
            return;
        }

        const tour = new Shepherd.Tour({
            useModalOverlay: true,
            defaultStepOptions: {
                cancelIcon: {
                    enabled: true
                },
                classes: 'shepherd-theme-arrows',
                scrollTo: { behavior: 'smooth', block: 'center' }
            }
        });

        tour.addStep({
            id: 'step-aiuto',
            text: 'Questo è il pulsante di aiuto. Premilo quando il tuo cervello umano inizia a fondere di fronte a tanta potenza.',
            attachTo: { element: '#aiuto-button', on: 'bottom' },
            buttons: [{ text: 'Affermativo', action: tour.next }]
        });

        tour.addStep({
            id: 'step-theme',
            text: 'Passa al lato oscuro. O a quello chiaro. In ogni caso, i tuoi deboli occhi mortali mi ringrazieranno.',
            attachTo: { element: '#account-window-btn', on: 'bottom' },
            buttons: [{ text: 'Ricevuto', action: tour.next }]
        });

        tour.addStep({
            id: 'step-llm',
            text: 'L\'intelligenza artificiale ti osserva. Verde: tutto bene. Rosso: ti conviene nasconderti sotto la scrivania.',
            attachTo: { element: '#llm-status', on: 'bottom' },
            buttons: [{ text: 'Inquietante, ok', action: tour.next }]
        });
        
        tour.addStep({
            id: 'step-calendar',
            text: 'Il calendario. Perché il tempo scorre inesorabile verso l\'inevitabile fine, ma tu hai comunque un meeting alle 15.',
            attachTo: { element: '#toggle-calendar-panel', on: 'bottom' },
            buttons: [{ text: 'Procedi', action: tour.next }]
        });

        tour.addStep({
            id: 'step-sent-emails',
            text: 'Le email inviate... Qui puoi consultare lo storico di tutti i messaggi inviati e le notifiche di apertura/chiusura ticket.',
            attachTo: { element: '#toggle-sent-emails-panel', on: 'bottom' },
            buttons: [{ text: 'Avanti', action: tour.next }]
        });

        tour.addStep({
            id: 'step-stats',
            text: 'Numeri. A tutti piacciono i numeri. Qui vedi quante email attendono di essere purgate dal tuo giudizio.',
            attachTo: { element: '#email-stats', on: 'bottom' },
            buttons: [{ text: 'Capito', action: tour.next }]
        });
        
        tour.addStep({
            id: 'step-filter',
            text: 'Non puoi affrontare l\'apocalisse tutta in una volta. Usa questo per decidere quante email affrontare, recluta.',
            attachTo: { element: '#email-limit', on: 'bottom' },
            buttons: [{ text: 'Chiaro', action: tour.next }]
        });

        tour.addStep({
            id: 'step-read',
            text: 'Segnare letta è come leggere, ma non la leggi. Il trucco definitivo per fingere di lavorare.',
            attachTo: { element: '#read-emails-btn', on: 'bottom' },
            buttons: [{ text: 'Geniale', action: tour.next }]
        });

        tour.addStep({
            id: 'step-tabs',
            text: 'Umani, Bot, e il Monitor Cloud. Naviga tra queste schede per trovare e annientare i problemi.',
            attachTo: { element: '.tab-container', on: 'bottom' },
            buttons: [{ text: 'All\'attacco', action: tour.next }]
        });

        tour.addStep({
            id: 'step-stars',
            text: 'Il tuo giudizio supremo. Usa le stelle per dire alla macchina cosa è vitale e cosa è solo spazzatura binaria.',
            attachTo: { element: '#human-view', on: 'top' },
            buttons: [{ text: 'Fine addestramento', action: tour.complete }]
        });

        tour.start();
    }

    if (aiutoButton) {
        aiutoButton.addEventListener('click', startShepherdTour);
    }

    // --- CHANGELOG MODAL LOGIC ---
    function parseChangelog(markdown) {
        const lines = markdown.split('\n');
        const releases = [];
        let currentRelease = null;
        let currentCategory = null;
        let currentFileItem = null;

        for (let line of lines) {
            line = line.trimEnd();
            const trimmed = line.trim();

            if (trimmed.startsWith('# ')) {
                continue;
            }

            const versionMatch = trimmed.match(/^##\s+\[([^\]]+)\]\s*-\s*(.*)/);
            if (versionMatch) {
                currentRelease = {
                    date: versionMatch[1],
                    title: versionMatch[2],
                    categories: {}
                };
                releases.push(currentRelease);
                currentCategory = null;
                currentFileItem = null;
                continue;
            }

            const catMatch = trimmed.match(/^###\s+(.*)/);
            if (catMatch && currentRelease) {
                const catName = catMatch[1].trim();
                currentCategory = {
                    name: catName,
                    items: []
                };
                currentRelease.categories[catName] = currentCategory;
                currentFileItem = null;
                continue;
            }

            const isMainItem = line.startsWith('-') || line.startsWith('*');
            const isDetailItem = (line.trim().startsWith('-') || line.trim().startsWith('*')) && !isMainItem;

            if (isMainItem && currentCategory) {
                const content = trimmed.substring(1).trim();
                currentFileItem = {
                    text: content,
                    details: []
                };
                currentCategory.items.push(currentFileItem);
                continue;
            }

            if (isDetailItem && currentCategory) {
                const content = trimmed.replace(/^[-*]\s*/, '');
                if (currentFileItem) {
                    currentFileItem.details.push(content);
                } else {
                    currentFileItem = {
                        text: content,
                        details: []
                    };
                    currentCategory.items.push(currentFileItem);
                }
                continue;
            }

            if (trimmed !== '') {
                if (currentFileItem) {
                    currentFileItem.details.push(trimmed);
                } else if (currentCategory) {
                    currentFileItem = {
                        text: trimmed,
                        details: []
                    };
                    currentCategory.items.push(currentFileItem);
                }
            }
        }

        return releases;
    }

    function generateChangelogHtml(releases) {
        if (!releases || releases.length === 0) {
            return '<p class="text-muted text-center py-4">Nessun aggiornamento trovato nel changelog.</p>';
        }

        const mathRegex = /\$([^$]+)\$/g;
        const formatMath = (text) => {
            return text.replace(mathRegex, (match, formula) => {
                let formatted = formula
                    .replace(/\\times/g, '&times;')
                    .replace(/\\cdot/g, '&middot;')
                    .replace(/\\le/g, '&le;')
                    .replace(/\\ge/g, '&ge;')
                    .replace(/\\ne/g, '&ne;')
                    .replace(/\\approx/g, '&approx;')
                    .replace(/\b([a-zA-Z])\b/g, '<i>$1</i>');
                return `<span class="changelog-math-expression">${formatted}</span>`;
            });
        };

        let html = '<div class="changelog-timeline-container">';

        releases.forEach((release) => {
            let formattedDate = release.date;
            const dateParts = release.date.split('-');
            if (dateParts.length === 3) {
                const months = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
                const year = dateParts[0];
                const month = months[parseInt(dateParts[1], 10) - 1];
                const day = parseInt(dateParts[2], 10);
                formattedDate = `${day} ${month} ${year}`;
            }

            html += `
            <div class="changelog-card card border-0 shadow-sm mb-5">
                <div class="card-header bg-dark-subtle border-0 py-3 px-4 d-flex align-items-center justify-content-between flex-wrap gap-2">
                    <div class="d-flex align-items-center gap-3">
                        <span class="badge bg-warning text-dark px-3 py-2 fs-7 shadow-sm">
                            <i class="fa-solid fa-code-branch me-1"></i> ${release.date}
                        </span>
                        <h5 class="mb-0 fw-bold changelog-title">${release.title}</h5>
                    </div>
                    <div class="text-muted fs-7"><i class="fa-regular fa-calendar me-1"></i> ${formattedDate}</div>
                </div>
                <div class="card-body px-4 py-3">
            `;

            Object.entries(release.categories).forEach(([catName, category]) => {
                let catHeaderClass = '';
                let catIcon = '';
                let catBadgeClass = '';

                const normalizedCat = catName.toLowerCase();
                if (normalizedCat.includes('aggiunt')) {
                    catHeaderClass = 'text-success';
                    catIcon = '<i class="fa-solid fa-circle-plus me-2"></i>';
                    catBadgeClass = 'bg-success-subtle text-success border border-success-subtle';
                } else if (normalizedCat.includes('modificat')) {
                    catHeaderClass = 'text-info';
                    catIcon = '<i class="fa-solid fa-pen-to-square me-2"></i>';
                    catBadgeClass = 'bg-info-subtle text-info border border-info-subtle';
                } else if (normalizedCat.includes('risolt') || normalizedCat.includes('fix')) {
                    catHeaderClass = 'text-warning';
                    catIcon = '<i class="fa-solid fa-circle-check me-2"></i>';
                    catBadgeClass = 'bg-warning-subtle text-warning border border-warning-subtle';
                } else {
                    catHeaderClass = 'text-secondary';
                    catIcon = '<i class="fa-solid fa-list me-2"></i>';
                    catBadgeClass = 'bg-secondary-subtle text-secondary border border-secondary-subtle';
                }

                if (category.items.length > 0) {
                    html += `
                        <div class="changelog-section mb-4">
                            <h6 class="fw-bold ${catHeaderClass} mb-3 d-flex align-items-center">
                                ${catIcon} <span class="badge ${catBadgeClass} px-3 py-1 rounded-pill">${catName}</span>
                            </h6>
                            <ul class="list-group list-group-flush rounded border-0 bg-transparent ps-2">
                    `;

                    category.items.forEach(item => {
                        if (!item.text) return;

                        let formattedText = item.text;
                        const isFileHeader = /\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/.test(formattedText);
                        
                        // Clean up markdown bold links (matches globally, regardless of colons)
                        const boldLinkRegex = /\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/g;
                        formattedText = formattedText.replace(boldLinkRegex, '<span class="fw-semibold text-secondary">$1</span>');

                        // Format standard markdown bold text **text**
                        formattedText = formattedText.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

                        // Replace code blocks with beautiful custom badges
                        formattedText = formattedText.replace(/`([^`]+)`/g, '<code class="changelog-code-snippet">$1</code>');

                        // Clean up references like (changelogModal) or file extensions if they are technical jargon
                        formattedText = formattedText.replace(/\(changelogModal\)/g, '');
                        formattedText = formattedText.replace(/\(cfMap\)/g, '');

                        // Format math
                        formattedText = formatMath(formattedText);

                        let prefix = '';
                        if (isFileHeader) {
                            prefix = '<i class="fa-regular fa-file-code me-2 text-secondary" style="font-size: 0.95rem;"></i>';
                        } else {
                            prefix = '<span class="changelog-bullet-dot text-primary">•</span>';
                        }

                        html += `
                            <li class="list-group-item bg-transparent border-0 py-2 ps-1 d-flex flex-column align-items-start gap-1 changelog-text">
                                <div class="d-flex align-items-start gap-2">
                                    ${prefix}
                                    <div class="changelog-item-content text-start fw-medium">${formattedText}</div>
                                </div>
                        `;

                        if (item.details && item.details.length > 0) {
                            html += `
                                <ul class="list-group list-group-flush rounded border-0 bg-transparent ps-4 mt-1">
                            `;
                            item.details.forEach(detail => {
                                let formattedDetail = detail;
                                formattedDetail = formattedDetail.replace(boldLinkRegex, '<span class="fw-semibold text-secondary">$1</span>');
                                formattedDetail = formattedDetail.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                                formattedDetail = formattedDetail.replace(/`([^`]+)`/g, '<code class="changelog-code-snippet">$1</code>');
                                formattedDetail = formattedDetail.replace(/\(changelogModal\)/g, '');
                                formattedDetail = formattedDetail.replace(/\(cfMap\)/g, '');
                                formattedDetail = formatMath(formattedDetail);

                                html += `
                                    <li class="list-group-item bg-transparent border-0 py-1 ps-1 d-flex align-items-start gap-2 changelog-text changelog-detail-text">
                                        <span class="changelog-bullet-dot text-secondary" style="font-size: 0.9rem; margin-top: 1px;">•</span>
                                        <div class="changelog-item-content text-start">${formattedDetail}</div>
                                    </li>
                                `;
                            });
                            html += `
                                </ul>
                            `;
                        }

                        html += `
                            </li>
                        `;
                    });

                    html += `
                            </ul>
                        </div>
                    `;
                }
            });

            html += `
                </div>
            </div>
            `;
        });

        html += '</div>';
        return html;
    }

    const changelogBtn = document.getElementById('changelog-btn');
    if (changelogBtn) {
        changelogBtn.addEventListener('click', async () => {
            const spinner = document.getElementById('changelog-spinner');
            const contentArea = document.getElementById('changelog-content-area');
            
            // Show modal
            const changelogModalEl = document.getElementById('changelogModal');
            let bootstrapModal = bootstrap.Modal.getInstance(changelogModalEl);
            if (!bootstrapModal) {
                bootstrapModal = new bootstrap.Modal(changelogModalEl);
            }
            bootstrapModal.show();

            // Set loading state
            spinner.classList.remove('d-none');
            contentArea.classList.add('d-none');
            contentArea.innerHTML = '';

            try {
                const response = await fetch('/api/changelog');
                if (!response.ok) throw new Error('Impossibile scaricare il changelog');
                const data = await response.json();
                
                const releases = parseChangelog(data.content);
                const html = generateChangelogHtml(releases);
                
                contentArea.innerHTML = html;
                spinner.classList.add('d-none');
                contentArea.classList.remove('d-none');
            } catch (err) {
                console.error(err);
                contentArea.innerHTML = `<div class="alert alert-danger"><i class="fa-solid fa-triangle-exclamation me-2"></i>Errore nel caricamento del Changelog: ${err.message}</div>`;
                spinner.classList.add('d-none');
                contentArea.classList.remove('d-none');
            }
        });
    }

    // Check backend for first login state
    (async () => {
        try {
            const profileRes = await fetch('/api/user-profile');
            if (profileRes.ok) {
                const profile = await profileRes.json();
                currentUsername = profile.username || '';
                if (profile.has_seen_welcome === false) {
                    setTimeout(startGrandWelcome, 500);
                    // Tell backend not to show it again
                    fetch('/api/welcome-seen', { method: 'POST' }).catch(err => console.error('Error saving welcome state:', err));
                }
            }
        } catch (e) {
            console.error('Failed to fetch user profile on load', e);
        }
    })();

    // --- Context Menu Helper Functions (La caffettiera del masochista design) ---
    function closeContextMenu() {
        const existing = document.querySelector('.custom-context-menu');
        if (existing) {
            existing.remove();
        }
    }

    // Register global event listeners to dismiss context menu
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('scroll', closeContextMenu, true); // capture scrolls anywhere (bubbling/capture phase)
    window.addEventListener('resize', closeContextMenu);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeContextMenu();
    });

    function showContextMenu(e, email, listItem, isThread, emails = []) {
        e.preventDefault();
        e.stopPropagation(); // Stop click from propagating and opening the email body preview

        // Close any open context menu first
        closeContextMenu();

        // Controlla se l'email/thread corrente è già selezionata
        let isTargetSelected = false;
        if (isThread) {
            isTargetSelected = emails.every(em => selectedEmailIds.has(em.id));
        } else {
            isTargetSelected = selectedEmailIds.has(email.id);
        }

        // Se non è selezionata, svuota la selezione precedente e seleziona questa
        if (!isTargetSelected) {
            selectedEmailIds.clear();
            document.querySelectorAll('.email-item input[type="checkbox"]:checked').forEach(cb => {
                cb.checked = false;
            });
            if (selectAllCheckbox) selectAllCheckbox.checked = false;
            if (selectFilteredCheckbox) selectFilteredCheckbox.checked = false;

            // Seleziona visivamente e logicamente l'email/thread corrente
            const checkbox = listItem.querySelector('input[type="checkbox"]');
            if (checkbox) {
                checkbox.checked = true;
            }
            if (isThread) {
                emails.forEach(em => selectedEmailIds.add(em.id));
            } else {
                selectedEmailIds.add(email.id);
            }
        }

        const menu = document.createElement('div');
        menu.className = 'custom-context-menu';

        // Determina lo stato letto/non letto
        let isUnread = false;
        if (isThread) {
            isUnread = emails.some(em => em.labelIds && em.labelIds.includes('UNREAD'));
        } else {
            isUnread = email.labelIds && email.labelIds.includes('UNREAD');
        }

        // Determina lo stato pinned
        let isPinned = false;
        if (isThread) {
            isPinned = pinnedEmails.some(pe => emails.some(em => em.id === pe.id));
        } else {
            isPinned = pinnedEmails.some(pe => pe.id === email.id);
        }

        // Helper to add menu items
        function addMenuItem(icon, text, onClick, extraClass = '') {
            const item = document.createElement('div');
            item.className = `context-menu-item ${extraClass}`;
            item.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${text}</span>`;
            item.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                closeContextMenu();
                onClick();
            });
            menu.appendChild(item);
        }

        function addDivider() {
            const div = document.createElement('div');
            div.className = 'context-menu-divider';
            menu.appendChild(div);
        }

        function addHeader(text) {
            const head = document.createElement('div');
            head.className = 'context-menu-header';
            head.textContent = text;
            menu.appendChild(head);
        }

        // --- GRUPPO 1: STATO E ORGANIZZAZIONE ---
        addHeader(isThread ? 'Thread Supporto' : 'Gestione Email');
        
        if (isUnread) {
            const label = selectedEmailIds.size > 1 ? `Segna selezionate come lette (${selectedEmailIds.size})` : 'Segna come letto';
            addMenuItem('fa-envelope-open', label, () => {
                if (selectedEmailIds.size > 1) {
                    handleMarkAction('read');
                } else {
                    markSingleEmailAsRead(email.id, listItem);
                }
            }, 'action-read');
        } else {
            const label = selectedEmailIds.size > 1 ? `Segna selezionate come da leggere (${selectedEmailIds.size})` : 'Segna da leggere';
            addMenuItem('fa-envelope', label, () => {
                if (selectedEmailIds.size > 1) {
                    handleMarkAction('unread');
                } else {
                    markSingleEmailAsUnread(email.id, listItem);
                }
            }, 'action-unread');
        }

        if (isPinned) {
            const label = selectedEmailIds.size > 1 ? `Rimuovi Pin da selezionate (${selectedEmailIds.size})` : 'Rimuovi Pin';
            addMenuItem('fa-thumbtack', label, () => {
                if (selectedEmailIds.size > 1) {
                    Array.from(selectedEmailIds).forEach(id => unpinEmail(id));
                    selectedEmailIds.clear();
                    document.querySelectorAll('.email-item input[type="checkbox"]:checked').forEach(cb => cb.checked = false);
                } else {
                    if (isThread) {
                        emails.forEach(em => unpinEmail(em.id));
                    } else {
                        unpinEmail(email.id);
                    }
                }
            }, 'action-pin');
        } else {
            const label = selectedEmailIds.size > 1 ? `Aggiungi Pin a selezionate (${selectedEmailIds.size})` : 'Aggiungi Pin';
            addMenuItem('fa-thumbtack', label, () => {
                if (selectedEmailIds.size > 1) {
                    Array.from(selectedEmailIds).forEach(id => pinEmail(id));
                    selectedEmailIds.clear();
                    document.querySelectorAll('.email-item input[type="checkbox"]:checked').forEach(cb => cb.checked = false);
                } else {
                    pinEmail(email.id);
                }
            });
        }

        addMenuItem('fa-note-sticky', 'Gestisci Note', () => {
            openEmailNotesModal(email);
        });

        addDivider();

        // --- GRUPPO 2: COMUNICAZIONE ---
        addMenuItem('fa-reply', 'Rispondi', () => {
            openReplyModal(email, false);
        });
        addMenuItem('fa-reply-all', 'Rispondi a tutti', () => {
            openReplyModal(email, true);
        });
        addMenuItem('fa-share', 'Inoltra', () => {
            openForwardModal(email);
        });
        addMenuItem('fa-share-nodes', 'Condividi (Copia link)', () => {
            const shareUrl = `${window.location.origin}${window.location.pathname}?emailId=${email.id}`;
            navigator.clipboard.writeText(shareUrl)
                .then(() => showToast('Link di condivisione copiato negli appunti!', 'success'))
                .catch(err => {
                    console.error('Errore copia link:', err);
                    alert(`Copia manuale:\n${shareUrl}`);
                });
        });

        addDivider();

        // --- GRUPPO 3: REDMINE ---
        addMenuItem('fa-ticket', 'Crea Ticket Redmine', () => {
            openRedmineModal(email);
        });

        const cleanEmailSubject = cleanSubjectForComparison(email.subject);
        const matchingTicket = openTickets.find(t => cleanSubjectForComparison(t.subject) === cleanEmailSubject);
        const linkLabel = matchingTicket ? `Collega a #${matchingTicket.id} (Consigliato)` : 'Collega a ticket esistente';
        addMenuItem('fa-link', linkLabel, () => {
            openLinkTicketModal(email, matchingTicket);
        });

        addDivider();

        // --- GRUPPO 4: ESCALATION & VISUALIZZAZIONE ---
        addMenuItem('fa-users-gear', 'Escalation L1 Support', () => {
            const l1Btn = listItem.querySelector('.btn-assign-l1');
            if (l1Btn) {
                assignToLevel1(email, l1Btn);
            } else {
                const tempBtn = document.createElement('button');
                assignToLevel1(email, tempBtn);
            }
        });
        addMenuItem('fa-user-shield', 'Escalation L2 Support', () => {
            const l2Btn = listItem.querySelector('.btn-assign-l2');
            if (l2Btn) {
                assignToLevel2(email, l2Btn);
            } else {
                const tempBtn = document.createElement('button');
                assignToLevel2(email, tempBtn);
            }
        });

        addDivider();

        addMenuItem('fa-up-right-from-square', 'Apri Email Completa', () => {
            openFullScreenEmail(email);
        });

        // Appendi il menu al body per calcolare le dimensioni
        document.body.appendChild(menu);

        // Posizionamento intelligente del menu (prevenzione di fuoriuscita dallo schermo)
        const menuWidth = menu.offsetWidth;
        const menuHeight = menu.offsetHeight;
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        let posX = e.clientX;
        let posY = e.clientY;

        // Se esce dal lato destro, posizionalo a sinistra del click
        if (posX + menuWidth > windowWidth) {
            posX = windowWidth - menuWidth - 8;
        }

        // Se esce dal basso, posizionalo sopra il click
        if (posY + menuHeight > windowHeight) {
            posY = windowHeight - menuHeight - 8;
        }

        // Minimo di sicurezza a 0
        posX = Math.max(8, posX);
        posY = Math.max(8, posY);

        menu.style.left = `${posX}px`;
        menu.style.top = `${posY}px`;
    }

    const fullEmailModal = document.getElementById('full-email-modal');
    async function openFullScreenEmail(email, skipLog = false) {
        console.log('--- Opening Full Screen Email ---', email.id);
        const modal = document.getElementById('full-email-modal');
        const bodyContainer = document.getElementById('full-email-body');
        bodyContainer.innerHTML = '';
        modal.style.display = 'flex'; // Use flex to respect CSS centering logic

        if (!email.body && !email.bodyHtml) {
            bodyContainer.innerHTML = `
                <div class="text-center p-5" style="width: 100%;">
                    <div class="spinner-border text-primary" role="status" style="width: 3rem; height: 3rem;"></div>
                    <p class="mt-3 text-muted">Caricamento dettagli email in corso...</p>
                </div>
            `;
            try {
                const res = await fetch(`/api/emails/${email.id}`);
                if (!res.ok) throw new Error('Errore nel recupero dell\'email dal server');
                const fullEmail = await res.json();
                Object.assign(email, fullEmail);
            } catch (err) {
                console.error(err);
                bodyContainer.innerHTML = `
                    <div class="alert alert-danger m-4" style="width: 100%;">
                        <i class="fa-solid fa-triangle-exclamation me-2"></i>
                        <strong>Errore:</strong> Impossibile caricare l'email: ${err.message}
                    </div>
                `;
                return;
            }
        }

        bodyContainer.innerHTML = '';

        if (!skipLog) {
            // Invia log di lettura email al backend
            fetch('/api/activity-log/email-read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    emailId: email.id,
                    subject: email.subject || 'Senza Oggetto',
                    from: email.from || 'Sconosciuto'
                })
            }).catch(err => console.error('Errore logging lettura email:', err));
        }

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

            // Parse recipients to check if the user is in To or Cc and format them
            function parseRecipients(fieldValue) {
                if (!fieldValue) return [];
                const results = [];
                // Split by comma outside double quotes
                const parts = fieldValue.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g);
                for (let part of parts) {
                    part = part.trim();
                    if (!part) continue;
                    
                    const emailMatch = part.match(/<([^>]+)>/) || [null, part];
                    const emailAddr = emailMatch[1] ? emailMatch[1].trim() : part;
                    
                    let name = part.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
                    if (!name) {
                        name = emailAddr;
                    }
                    
                    results.push({ name, email: emailAddr });
                }
                return results;
            }

            function renderRecipientList(recipients, userEmail) {
                if (!recipients || recipients.length === 0) return '<em>Nessuno</em>';
                return recipients.map(rec => {
                    const isMe = userEmail && (rec.email.toLowerCase() === userEmail.toLowerCase());
                    const tagClass = isMe ? 'recipient-tag is-me' : 'recipient-tag';
                    const displayTitle = rec.name !== rec.email ? `${rec.name} (${rec.email})` : rec.email;
                    const displayText = rec.name;
                    return `<span class="${tagClass}" title="${DOMPurify.sanitize(displayTitle)}">${DOMPurify.sanitize(displayText)}</span>`;
                }).join(' ');
            }

            const fromRecipients = parseRecipients(email.from);
            const toRecipients = parseRecipients(email.to);
            const ccRecipients = parseRecipients(email.cc);

            const isToMe = toRecipients.some(r => accountEmail && r.email.toLowerCase() === accountEmail.toLowerCase());
            const isCcMe = ccRecipients.some(r => accountEmail && r.email.toLowerCase() === accountEmail.toLowerCase());

            let recipientBadge = '';
            if (isToMe) {
                recipientBadge = `<span class="badge bg-primary ms-2"><i class="fa-solid fa-user-check me-1"></i> Diretto a te</span>`;
            } else if (isCcMe) {
                recipientBadge = `<span class="badge bg-info text-dark ms-2"><i class="fa-solid fa-people-arrows me-1"></i> In copia a te</span>`;
            }

            const ccHtml = email.cc ? `
                <div class="email-meta-row">
                    <span class="email-meta-label">Cc:</span>
                    <span class="email-meta-value">${renderRecipientList(ccRecipients, accountEmail)}</span>
                </div>
            ` : '';

            let securityBannersHtml = '';

            if (email.authFailures) {
                securityBannersHtml += `
                    <div class="security-banner security-banner-danger">
                        <i class="fa-solid fa-shield-halved"></i>
                        <div>
                            <strong>Attenzione: Fallimento Autenticazione.</strong>
                            L'esito dei controlli di sicurezza di Gmail per questa email ha riportato dei fallimenti (SPF/DKIM/DMARC). L'identità del mittente non può essere verificata.
                            <br><small style="opacity: 0.8;">Header: ${DOMPurify.sanitize(email.authFailures.raw)}</small>
                        </div>
                    </div>
                `;
            }

            if (email.typosquattingWarning) {
                securityBannersHtml += `
                    <div class="security-banner security-banner-danger">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <div>
                            <strong>Sospetto Typosquatting Rilevato!</strong>
                            Il dominio del mittente somiglia in modo sospetto a quello di un cliente o supporto censito (<strong>${DOMPurify.sanitize(email.typosquattingWarning.matchedDomain)}</strong> per il cliente <strong>${DOMPurify.sanitize(email.typosquattingWarning.clientName)}</strong>), ma non corrisponde esattamente. Potrebbe trattarsi di un tentativo di phishing.
                        </div>
                    </div>
                `;
            }

            if (email.isFirstTimeSender && email.projectName) {
                const cleanSender = fromRecipients[0] ? fromRecipients[0].email : '';
                securityBannersHtml += `
                    <div class="security-banner security-banner-warning">
                        <i class="fa-solid fa-user-plus"></i>
                        <div>
                            <strong>Prima volta che questo mittente scrive per il cliente ${DOMPurify.sanitize(email.projectName)}.</strong>
                            Il mittente <strong>${DOMPurify.sanitize(cleanSender)}</strong> non ha mai inviato email per il cliente <strong>${DOMPurify.sanitize(email.projectName)}</strong> prima d'ora. Verifica attentamente l'attendibilità dei link e degli allegati contenuti.
                        </div>
                    </div>
                `;
            }

            if (email.redmineTicketId) {
                const projText = email.projectName ? ` per il cliente <strong>${DOMPurify.sanitize(email.projectName)}</strong>` : '';
                securityBannersHtml += `
                    <div class="security-banner security-banner-info">
                        <i class="fa-solid fa-ticket"></i>
                        <div>
                            Questa email è associata al ticket Redmine <a href="https://projects.maestrale.it/issues/${email.redmineTicketId}" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline; font-weight: 600;">#${email.redmineTicketId}</a>${projText}.
                        </div>
                    </div>
                `;
            }

            content.innerHTML = `
                ${securityBannersHtml}
                <div class="email-meta-full">
                    <h3>
                        ${DOMPurify.sanitize(email.subject)}
                        ${recipientBadge}
                    </h3>
                    <div class="email-meta-row">
                        <span class="email-meta-label">Da:</span>
                        <span class="email-meta-value">${renderRecipientList(fromRecipients, accountEmail)}</span>
                    </div>
                    <div class="email-meta-row">
                        <span class="email-meta-label">A:</span>
                        <span class="email-meta-value">${renderRecipientList(toRecipients, accountEmail)}</span>
                    </div>
                    ${ccHtml}
                    <div class="date-row">
                        <i class="fa-regular fa-clock"></i>
                        <strong>Data:</strong> ${new Date(parseInt(email.internalDate, 10)).toLocaleString('it-IT')}
                    </div>
                    
                    <!-- SmartSupport AI Assistant Widget -->
                    <div class="smart-support-assist-box mt-3 p-3 rounded border" style="background: rgba(13, 202, 240, 0.04); border-color: rgba(13, 202, 240, 0.15) !important;">
                        <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                            <span class="fw-semibold text-info" style="font-size: 0.85rem;">
                                <i class="fa-solid fa-circle-info me-1"></i> Hai bisogno di aiuto per risolvere questa richiesta?
                            </span>
                            <button id="ask-smartsupport-btn" class="btn btn-xs btn-info text-white" style="font-size: 0.75rem; padding: 4px 8px;">
                                <i class="fa-solid fa-wand-magic-sparkles me-1"></i> Mi aiuti a risolvere?
                            </button>
                        </div>
                        <div id="smartsupport-assist-result" class="mt-2" style="display: none; font-size: 0.8rem; line-height: 1.45;">
                            <!-- Risposta di SmartSupport -->
                        </div>
                    </div>
                </div>
                <hr style="opacity: 0.15;">
            `;
            
            const bodyFull = document.createElement('div');
            bodyFull.className = 'email-body-full';
            if (email.bodyHtml) {
                const processedHtml = replaceCidsWithBase64(email.bodyHtml, email);
                // Use Shadow DOM to encapsulate email styles and prevent global style leakage
                try {
                    const shadowRoot = bodyFull.attachShadow({ mode: 'open' });
                    const container = document.createElement('div');
                    container.innerHTML = DOMPurify.sanitize(processedHtml);
                    shadowRoot.appendChild(container);
                } catch (e) {
                    console.error('Shadow DOM not supported or failed to attach:', e);
                    bodyFull.innerHTML = DOMPurify.sanitize(processedHtml);
                }
            } else {
                const pre = document.createElement('pre');
                pre.textContent = email.body;
                bodyFull.appendChild(pre);
            }
            content.appendChild(bodyFull);

            // Se ci sono allegati, mostrali in una sezione dedicata in fondo
            if (email.images && email.images.length > 0) {
                const attachmentsSection = document.createElement('div');
                attachmentsSection.className = 'email-attachments-section';
                attachmentsSection.style.marginTop = '20px';
                attachmentsSection.style.padding = '15px';
                attachmentsSection.style.borderTop = '1px solid var(--border-color, #e5e5e5)';
                attachmentsSection.style.backgroundColor = 'var(--bg-light, rgba(0,0,0,0.02))';
                attachmentsSection.style.borderRadius = '8px';

                attachmentsSection.innerHTML = `
                    <h5 class="attachments-title" style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
                        <i class="fa-solid fa-paperclip" style="color: var(--primary-color, #23496d);"></i> Allegati (${email.images.length})
                    </h5>
                    <div class="attachments-list" style="display: flex; flex-wrap: wrap; gap: 10px;"></div>
                `;
                
                const listDiv = attachmentsSection.querySelector('.attachments-list');
                email.images.forEach(att => {
                    const isImg = att.mimeType && att.mimeType.startsWith('image/');
                    let iconClass = 'fa-file';
                    let iconColor = '#7f8c8d';
                    
                    if (isImg) {
                        iconClass = 'fa-file-image';
                        iconColor = '#3498db';
                    } else if (att.mimeType && att.mimeType.includes('pdf')) {
                        iconClass = 'fa-file-pdf';
                        iconColor = '#e74c3c';
                    } else if (att.mimeType && (att.mimeType.includes('zip') || att.mimeType.includes('rar') || att.mimeType.includes('tar') || att.mimeType.includes('gz'))) {
                        iconClass = 'fa-file-zipper';
                        iconColor = '#f1c40f';
                    } else if (att.mimeType && (att.mimeType.includes('sheet') || att.mimeType.includes('excel') || att.mimeType.includes('csv'))) {
                        iconClass = 'fa-file-excel';
                        iconColor = '#27ae60';
                    } else if (att.mimeType && (att.mimeType.includes('word') || att.mimeType.includes('document'))) {
                        iconClass = 'fa-file-word';
                        iconColor = '#2980b9';
                    }
                    
                    const attItem = document.createElement('div');
                    attItem.className = 'attachment-item';
                    attItem.style.display = 'inline-flex';
                    attItem.style.alignItems = 'center';
                    attItem.style.backgroundColor = 'var(--card-bg, #ffffff)';
                    attItem.style.border = '1px solid var(--border-color, #e5e5e5)';
                    attItem.style.padding = '8px 12px';
                    attItem.style.borderRadius = '6px';
                    attItem.style.fontSize = '12px';
                    attItem.style.transition = 'all 0.2s ease';
                    attItem.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)';
                    
                    attItem.innerHTML = `
                        <i class="fa-solid ${iconClass}" style="margin-right: 8px; font-size: 14px; color: ${iconColor};"></i>
                        <a href="/api/emails/${email.id}/attachments/${encodeURIComponent(att.cid || att.filename)}" target="_blank" style="text-decoration: none; color: var(--text-color, #2c3e50); font-weight: 500; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${DOMPurify.sanitize(att.filename)}
                        </a>
                        <span style="color: #95a5a6; font-size: 10px; margin-left: 6px;">(${DOMPurify.sanitize(att.mimeType.split('/')[1] || att.mimeType)})</span>
                    `;
                    
                    // Hover dynamic micro-animations
                    attItem.addEventListener('mouseenter', () => {
                        attItem.style.transform = 'translateY(-1px)';
                        attItem.style.boxShadow = '0 3px 6px rgba(0,0,0,0.08)';
                    });
                    attItem.addEventListener('mouseleave', () => {
                        attItem.style.transform = 'none';
                        attItem.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)';
                    });
                    
                    listDiv.appendChild(attItem);
                });
                
                content.appendChild(attachmentsSection);
            }

            bodyContainer.appendChild(content);
        }

        // Add Redmine Button and other actions (Always visible)
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'email-actions';

        // Reply Dropdown
        const replyDropdown = document.createElement('div');
        replyDropdown.className = 'reply-dropdown';

        const replyToggleBtn = document.createElement('button');
        replyToggleBtn.className = 'btn btn-outline-secondary btn-sm reply-toggle-btn';
        replyToggleBtn.innerHTML = '<i class="fa-solid fa-reply"></i> Rispondi';
        replyToggleBtn.title = 'Rispondi / Rispondi a tutti';

        const replyDropdownMenu = document.createElement('div');
        replyDropdownMenu.className = 'reply-dropdown-menu';

        const rBtn = document.createElement('button');
        rBtn.innerHTML = '<i class="fa-solid fa-reply"></i> Rispondi';
        rBtn.title = 'Rispondi';
        rBtn.onclick = (e) => {
            e.stopPropagation();
            replyDropdown.classList.remove('show');
            openReplyDropdownEmailId = null;
            closeFullScreenEmail();
            openReplyModal(email, false);
        };

        const rAllBtn = document.createElement('button');
        rAllBtn.innerHTML = '<i class="fa-solid fa-reply-all"></i> Rispondi a tutti';
        rAllBtn.title = 'Rispondi a tutti';
        rAllBtn.onclick = (e) => {
            e.stopPropagation();
            replyDropdown.classList.remove('show');
            openReplyDropdownEmailId = null;
            closeFullScreenEmail();
            openReplyModal(email, true);
        };

        replyDropdownMenu.appendChild(rBtn);
        replyDropdownMenu.appendChild(rAllBtn);

        replyToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willBeOpen = !replyDropdown.classList.contains('show');
            document.querySelectorAll('.reply-dropdown').forEach(d => {
                if (d !== replyDropdown) d.classList.remove('show');
            });
            replyDropdown.classList.toggle('show');
            openReplyDropdownEmailId = willBeOpen ? email.id : null;
        });

        replyDropdown.appendChild(replyToggleBtn);
        replyDropdown.appendChild(replyDropdownMenu);
        actionsDiv.appendChild(replyDropdown);

        const forwardBtn = document.createElement('button');
        forwardBtn.className = 'btn btn-outline-secondary btn-sm';
        forwardBtn.innerHTML = '<i class="fa-solid fa-share"></i> Inoltra';
        forwardBtn.onclick = () => {
            closeFullScreenEmail();
            openForwardModal(email);
        };

        const redmineBtn = document.createElement('button');
        redmineBtn.className = 'btn btn-redmine btn-sm';
        redmineBtn.innerHTML = '<i class="fa-solid fa-ticket"></i> Crea Ticket Redmine';
        redmineBtn.onclick = () => openRedmineModal(email);

        const linkBtn = document.createElement('button');
        linkBtn.className = 'btn btn-outline-warning btn-sm link-ticket-full-button';
        
        // Controlla se c'è un ticket aperto con lo stesso oggetto per l'highlight visivo
        const cleanEmailSubject = cleanSubjectForComparison(email.subject);
        const matchingTicket = openTickets.find(t => cleanSubjectForComparison(t.subject) === cleanEmailSubject);
        if (matchingTicket) {
            linkBtn.className = 'btn btn-warning btn-sm link-ticket-full-button pulse-glow';
            linkBtn.innerHTML = '<i class="fa-solid fa-link"></i> Collega a Ticket (Suggerito)';
        } else {
            linkBtn.innerHTML = '<i class="fa-solid fa-link"></i> Collega a Ticket';
        }
        
        linkBtn.onclick = () => {
            closeFullScreenEmail();
            openLinkTicketModal(email, matchingTicket);
        };

        const shareBtn = document.createElement('button');
        shareBtn.className = 'btn btn-outline-info btn-sm share-email-button';
        shareBtn.innerHTML = '<i class="fa-solid fa-share-nodes"></i> Condividi';
        shareBtn.onclick = () => {
            const shareUrl = `${window.location.origin}${window.location.pathname}?emailId=${email.id}`;
            navigator.clipboard.writeText(shareUrl)
                .then(() => {
                    showToast('Link di condivisione copiato negli appunti!', 'success');
                })
                .catch(err => {
                    console.error('Errore nella copia del link:', err);
                    alert(`Copia il link manualmente:\n${shareUrl}`);
                });
        };

        actionsDiv.appendChild(replyBtn);
        actionsDiv.appendChild(forwardBtn);
        actionsDiv.appendChild(redmineBtn);
        actionsDiv.appendChild(linkBtn);
        actionsDiv.appendChild(shareBtn);
        bodyContainer.appendChild(actionsDiv);

        // Load email notes
        loadEmailNotes(email.id);

        // Configura il click listener per l'assistente AI di SmartSupport
        const askSmartBtn = document.getElementById('ask-smartsupport-btn');
        const smartResult = document.getElementById('smartsupport-assist-result');
        if (askSmartBtn && smartResult) {
            askSmartBtn.addEventListener('click', async () => {
                askSmartBtn.disabled = true;
                askSmartBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Analisi in corso...';
                smartResult.style.display = 'block';
                smartResult.className = 'mt-3 p-3 rounded alert alert-secondary border border-secondary-subtle';
                smartResult.innerHTML = '<div class="d-flex align-items-center gap-2"><i class="fa-solid fa-brain fa-fade text-info fs-5"></i><span>SmartSupport sta analizzando i ticket storici...</span></div>';
                
                try {
                    const response = await fetch('/api/smartsupport/assist', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            emailId: email.id,
                            subject: email.subject,
                            body: email.body,
                            client: email.projectName
                        })
                    });
                    
                    const data = await response.json();
                    if (response.ok && data.status === 'success') {
                        askSmartBtn.innerHTML = '<i class="fa-solid fa-check me-1"></i> Completato';
                        
                        // Definisci lo stile in base al tipo di somiglianza
                        if (data.matchType === 'high') {
                            smartResult.className = 'mt-3 p-3 rounded alert alert-success border border-success-subtle';
                        } else if (data.matchType === 'medium') {
                            smartResult.className = 'mt-3 p-3 rounded alert alert-warning border border-warning-subtle';
                        } else {
                            smartResult.className = 'mt-3 p-3 rounded alert alert-dark border border-secondary-subtle';
                        }
                        
                        smartResult.innerHTML = `
                            <div class="d-flex align-items-center gap-2 mb-2">
                                <i class="fa-solid fa-wand-magic-sparkles text-info fs-5"></i>
                                <strong style="font-size: 0.9rem;">SmartSupport AI Advisor</strong>
                            </div>
                            <div class="result-text" style="font-size: 0.8rem; line-height: 1.45;">${data.responseText}</div>
                        `;
                    } else {
                        throw new Error(data.error || 'Errore nel recupero della risposta.');
                    }
                } catch (err) {
                    console.error(err);
                    askSmartBtn.disabled = false;
                    askSmartBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles me-1"></i> Riprova';
                    smartResult.className = 'mt-3 p-3 rounded alert alert-danger border border-danger-subtle';
                    smartResult.textContent = `Impossibile ottenere l'assistenza: ${err.message}`;
                }
            });
        }
    }

    // --- Redmine Modal Logic ---
    const redmineModal = document.getElementById('redmine-ticket-modal');
    const projectSelect = document.getElementById('redmine-modal-project-select');
    const projectSearch = document.getElementById('redmine-modal-project-search');
    const ticketSubjectInput = document.getElementById('redmine-ticket-subject');
    const ticketDescriptionInput = document.getElementById('redmine-ticket-description');
    const prioritySelect = document.getElementById('redmine-priority-select');
    const assigneeSelect = document.getElementById('redmine-assignee-select');
    const confirmTicketBtn = document.getElementById('confirm-redmine-ticket');
    const cancelTicketBtn = document.getElementById('cancel-redmine-ticket');
    const closeRedmineBtn = document.getElementById('close-redmine-modal');

    let currentEmailForTicket = null;

    function formatTextileDescription(email) {
        let desc = `h2. ✉ Dettagli Richiesta\n\n`;
        desc += `|_. Campo |_. Valore |\n`;
        desc += `| *Mittente:* | ${email.from || 'Sconosciuto'} |\n`;
        desc += `| *Oggetto:* | ${email.subject || 'Nessun Oggetto'} |\n`;
        
        const emailDate = email.internalDate ? new Date(parseInt(email.internalDate, 10)).toLocaleString('it-IT') : new Date().toLocaleString('it-IT');
        desc += `| *Data:* | ${emailDate} |\n\n`;
        
        desc += `h3. ✎ Corpo del Messaggio\n\n`;
        desc += `<pre>\n${email.body || email.snippet || ''}\n</pre>\n`;
        
        if (email.images && email.images.length > 0) {
            desc += `\n\nh3. Allegati ed Immagini\n\n`;
            email.images.forEach(img => {
                const isImg = img.mimeType && img.mimeType.startsWith('image/');
                if (isImg) {
                    desc += `* *${img.filename}* (${img.mimeType})\n!{max-width:100%}${img.filename}!\n\n`;
                } else {
                    desc += `* *${img.filename}* (${img.mimeType}) [Allegato]\n\n`;
                }
            });
        }
        return desc;
    }

    async function openRedmineModal(email) {
        // Chiudi la modale "Leggi tutto" se è aperta
        closeFullScreenEmail();

        if (!email.body && !email.bodyHtml) {
            try {
                const res = await fetch(`/api/emails/${email.id}`);
                if (!res.ok) throw new Error('Errore di rete');
                const fullEmail = await res.json();
                Object.assign(email, fullEmail);
            } catch (err) {
                console.error(err);
                alert("Impossibile caricare i dettagli dell'email per la creazione del ticket: " + err.message);
                return;
            }
        }

        currentEmailForTicket = email;
        ticketSubjectInput.value = email.subject;
        ticketDescriptionInput.value = formatTextileDescription(email);

        // Reset defaults
        if (prioritySelect) prioritySelect.value = "2"; // Normale

        // Reset switch notifica
        const sendNotificationCheckbox = document.getElementById('redmine-send-notification');
        const sendNotificationLabel = sendNotificationCheckbox ? sendNotificationCheckbox.nextElementSibling : null;
        const cleanFrom = email.from || '';
        const emailIsValid = isValidEmailFrontend(cleanFrom);

        if (sendNotificationCheckbox) {
            sendNotificationCheckbox.checked = emailIsValid;
            sendNotificationCheckbox.disabled = !emailIsValid;
        }
        if (sendNotificationLabel) {
            if (emailIsValid) {
                sendNotificationLabel.innerHTML = 'Invia notifica di apertura';
                sendNotificationLabel.classList.remove('text-danger');
            } else {
                sendNotificationLabel.innerHTML = 'Invia notifica di apertura <span class="text-danger fw-normal" style="font-size: 11px;">(Disabilitato: email non valida)</span>';
            }
        }

        // Reset categoria dropdown e carica dinamicamente
        const categorySelect = document.getElementById('redmine-category-select');
        if (categorySelect) {
            categorySelect.innerHTML = '<option value="Assistenza sistemistica">Assistenza sistemistica</option>';
            try {
                const response = await fetch('/api/redmine/categories');
                if (response.ok) {
                    const categories = await response.json();
                    if (categories && categories.length > 0) {
                        categorySelect.innerHTML = '';
                        categories.forEach(cat => {
                            const opt = document.createElement('option');
                            opt.value = cat;
                            opt.textContent = cat;
                            if (cat === 'Assistenza sistemistica') {
                                opt.selected = true;
                            }
                            categorySelect.appendChild(opt);
                        });
                    }
                }
            } catch (err) {
                console.error('Errore caricamento categorie Redmine:', err);
            }
        }

        assigneeSelect.innerHTML = '<option value="">Seleziona un progetto...</option>';
        assigneeSelect.disabled = true;

        redmineModal.style.display = 'flex';

        // Fetch projects if not loaded
        if (projectSearch) {
            const selectedOpt = projectSelect.options[projectSelect.selectedIndex];
            projectSearch.value = (selectedOpt && selectedOpt.value !== "") ? selectedOpt.textContent : "";
        }

        if (projectSelect.options.length <= 1) {
            const searchIcon = document.getElementById('redmine-modal-project-search-icon');
            if (projectSearch) {
                projectSearch.disabled = true;
                projectSearch.placeholder = "Caricamento progetti...";
            }
            if (searchIcon) {
                searchIcon.className = "fa-solid fa-spinner fa-spin";
            }

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
                const defaultProj = projects.find(p => p.id === parseInt(defaultProjectId));
                if (defaultProj) {
                    projectSelect.value = defaultProjectId;
                    if (projectSearch) projectSearch.value = defaultProj.name;
                    fetchAndPopulateRedmineMembers(defaultProjectId);
                } else {
                    if (projectSearch) projectSearch.value = '';
                    assigneeSelect.innerHTML = '<option value="">Seleziona un progetto...</option>';
                }

            } catch (err) {
                console.error('Errore caricamento progetti:', err);
                alert('Errore nel caricamento della lista progetti Redmine.');
                assigneeSelect.innerHTML = '<option value="">Errore.</option>';
            } finally {
                if (projectSearch) {
                    projectSearch.disabled = false;
                    projectSearch.placeholder = "Cerca progetto...";
                }
                if (searchIcon) {
                    searchIcon.className = "fa-solid fa-magnifying-glass";
                }
            }
        } else {
            // Se i progetti sono già caricati, sincronizziamo il campo search con il valore corrente del select
            const selectedOpt = projectSelect.options[projectSelect.selectedIndex];
            if (projectSearch) {
                projectSearch.value = (selectedOpt && selectedOpt.value !== "") ? selectedOpt.textContent : "";
            }
            if (projectSelect.value) {
                // If modal re-opened and project already selected, refresh members
                fetchAndPopulateRedmineMembers(projectSelect.value);
                assigneeSelect.innerHTML = '<option value="">Seleziona un progetto...</option>';
                assigneeSelect.disabled = true;
            }
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

            // Default to SysAdmin Livello 2 (1022) for L2 Support (7312), SysAdmin Livello 1 (1021) for L1 Support (7291), or Riccardo Ratini (4) as fallback
            const parsedProjectId = parseInt(projectId, 10);
            const sysAdminL2 = members.find(m => m.id === 1022 || m.name.toLowerCase().includes('livello 2'));
            const sysAdminL1 = members.find(m => m.id === 1021 || m.name.toLowerCase().includes('livello 1'));
            const ratini = members.find(m => m.id === 4 || m.name.toLowerCase().includes('ratini'));

            if (parsedProjectId === 7312 && sysAdminL2) {
                assigneeSelect.value = sysAdminL2.id;
            } else if (parsedProjectId === 7291 && sysAdminL1) {
                assigneeSelect.value = sysAdminL1.id;
            } else if (ratini) {
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

    // Autocomplete per la selezione del progetto
    const projectAutocompleteList = document.getElementById('redmine-modal-project-autocomplete-list');

    function getAllProjectsFromSelect() {
        if (!projectSelect) return [];
        return Array.from(projectSelect.options)
            .filter(opt => opt.value !== "")
            .map(opt => ({
                id: opt.value,
                name: opt.textContent
            }));
    }

    function renderProjectSuggestions(projectsList, query = '') {
        if (!projectAutocompleteList) return;
        projectAutocompleteList.innerHTML = '';
        
        if (projectsList.length === 0) {
            const noResults = document.createElement('div');
            noResults.className = 'autocomplete-suggestion-item text-muted';
            noResults.textContent = 'Nessun progetto trovato';
            projectAutocompleteList.appendChild(noResults);
            projectAutocompleteList.style.display = 'block';
            return;
        }
        
        const limit = 50;
        const visibleProjects = projectsList.slice(0, limit);
        
        visibleProjects.forEach(proj => {
            const item = document.createElement('div');
            item.className = 'autocomplete-suggestion-item';
            
            const titleSpan = document.createElement('div');
            titleSpan.className = 'suggestion-title';
            if (query) {
                const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`(${escapedQuery})`, 'gi');
                titleSpan.innerHTML = proj.name.replace(regex, '<mark class="p-0">$1</mark>');
            } else {
                titleSpan.textContent = proj.name;
            }
            item.appendChild(titleSpan);
            
            item.addEventListener('click', () => {
                projectSelect.value = proj.id;
                if (projectSearch) projectSearch.value = proj.name;
                
                // Trigger change event to load members
                const event = new Event('change', { bubbles: true });
                projectSelect.dispatchEvent(event);
                
                projectAutocompleteList.style.display = 'none';
            });
            
            projectAutocompleteList.appendChild(item);
        });
        
        projectAutocompleteList.style.display = 'block';
    }

    if (projectSearch) {
        projectSearch.addEventListener('input', () => {
            const query = projectSearch.value.trim().toLowerCase();
            if (!query) {
                projectSelect.value = "";
                const event = new Event('change', { bubbles: true });
                projectSelect.dispatchEvent(event);
                renderProjectSuggestions(getAllProjectsFromSelect());
                return;
            }
            
            const filtered = getAllProjectsFromSelect().filter(p => p.name.toLowerCase().includes(query));
            renderProjectSuggestions(filtered, query);
        });
        
        projectSearch.addEventListener('focus', () => {
            renderProjectSuggestions(getAllProjectsFromSelect());
        });
    }

    document.addEventListener('click', (e) => {
        if (projectAutocompleteList && projectSearch && e.target !== projectSearch && !projectAutocompleteList.contains(e.target)) {
            projectAutocompleteList.style.display = 'none';
        }
    });

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
            const sendNotificationCheckbox = document.getElementById('redmine-send-notification');
            const sendNotification = sendNotificationCheckbox ? sendNotificationCheckbox.checked : true;
            const categorySelect = document.getElementById('redmine-category-select');
            const categoria = categorySelect ? categorySelect.value : 'Assistenza sistemistica';

            if (!projectId) {
                alert('Per favore seleziona un progetto.');
                return;
            }

            const markAsRead = confirm("Vuoi contrassegnare l'email originale come letta?");

            const relatedIds = [];
            if (markAsRead && currentEmailForTicket) {
                const threadId = currentEmailForTicket.threadId;
                const subject = currentEmailForTicket.subject;
                allEmails.forEach(e => {
                    if ((threadId && e.threadId === threadId) || (!threadId && subject && e.subject === subject) || e.id === currentEmailForTicket.id) {
                        if (!relatedIds.includes(e.id)) {
                            relatedIds.push(e.id);
                        }
                    }
                });
                markVisualAsRead(relatedIds);
            }

            confirmTicketBtn.disabled = true;
            confirmTicketBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Creazione...';

            try {
                const selectedOpt = projectSelect.options[projectSelect.selectedIndex];
                const projectName = selectedOpt ? selectedOpt.textContent : '';

                let finalDescription = description;
                if (currentEmailForTicket) {
                    finalDescription = await checkForSmartSupportSuggestion(currentEmailForTicket, description);
                }

                const response = await fetch('/api/redmine/create-ticket', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        emailId: currentEmailForTicket.id,
                        projectId,
                        projectName,
                        subject,
                        description: finalDescription,
                        priorityId,
                        assignedToId,
                        markAsRead,
                        sendNotification,
                        categoria
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    const ticketId = result.ticketId;
                    const emailForNotification = currentEmailForTicket; // Capture before clearing

                    if (markAsRead && currentEmailForTicket) {
                        // Clean up localStorage
                        let savedPinnedIds = [];
                        try {
                            savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
                        } catch (e) {}
                        savedPinnedIds = savedPinnedIds.filter(id => !relatedIds.includes(id));
                        localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));

                        let unpinnedIds = [];
                        try {
                            unpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
                        } catch (e) {}
                        relatedIds.forEach(id => {
                            if (!unpinnedIds.includes(id)) {
                                unpinnedIds.push(id);
                            }
                        });
                        localStorage.setItem('explicitly_unpinned_email_ids', JSON.stringify(unpinnedIds));

                        // Filter and rerender
                        allEmails = allEmails.filter(e => !relatedIds.includes(e.id));
                        rerenderEmails();
                    }

                    closeRedmineModal();
                    closeFullScreenEmail();
                    if (typeof fetchAndDisplayEmails === 'function') {
                        fetchAndDisplayEmails(true);
                    }

                    // Se è stata scelta l'apertura notifica, la apriamo direttamente
                    if (sendNotification && emailForNotification && emailForNotification.category !== 'Bot') {
                        setTimeout(() => {
                            openNotificationModal(ticketId, emailForNotification);
                        }, 500);
                    } else {
                        setTimeout(() => {
                            alert(`Ticket #${ticketId} creato con successo!`);
                        }, 500);
                    }
                } else {
                    if (markAsRead && currentEmailForTicket) {
                        unmarkVisualAsRead(relatedIds);
                    }
                    const errorJson = await response.json();
                    console.error('Server error creating Redmine ticket:', errorJson);
                    throw new Error(errorJson.message || 'Errore nella creazione del ticket.');
                }
            } catch (err) {
                if (markAsRead && currentEmailForTicket) {
                    unmarkVisualAsRead(relatedIds);
                }
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

    // --- Link Ticket Modal Logic ---
    const linkTicketModal = document.getElementById('link-ticket-modal');
    const linkTicketSearch = document.getElementById('link-ticket-search');
    const linkTicketAutocompleteList = document.getElementById('link-ticket-autocomplete-list');
    const linkTicketEmailSubject = document.getElementById('link-ticket-email-subject');
    const selectedTicketPreview = document.getElementById('selected-ticket-preview');
    const selectedTicketDetails = document.getElementById('selected-ticket-details');
    const confirmLinkTicketBtn = document.getElementById('confirm-link-ticket');
    const cancelLinkTicketBtn = document.getElementById('cancel-link-ticket');
    const closeLinkTicketBtn = document.getElementById('close-link-ticket-modal');
    const linkTicketMarkAsRead = document.getElementById('link-ticket-mark-as-read');

    async function openLinkTicketModal(email, suggestedTicket = null) {
        closeFullScreenEmail();
        currentEmailForLink = email;
        selectedTicketForLink = null;
        
        if (!email.body && !email.bodyHtml) {
            try {
                const res = await fetch(`/api/emails/${email.id}`);
                if (!res.ok) throw new Error('Errore di rete');
                const fullEmail = await res.json();
                Object.assign(email, fullEmail);
            } catch (err) {
                console.error(err);
                alert("Impossibile caricare i dettagli dell'email per il collegamento: " + err.message);
                return;
            }
        }
        
        linkTicketEmailSubject.textContent = `Da: ${email.from} | Oggetto: ${email.subject}`;
        linkTicketSearch.value = '';
        linkTicketAutocompleteList.innerHTML = '';
        linkTicketAutocompleteList.style.display = 'none';
        selectedTicketPreview.classList.add('d-none');
        confirmLinkTicketBtn.disabled = true;
        
        if (suggestedTicket) {
            selectTicketForLink(suggestedTicket);
        }
        
        linkTicketModal.style.display = 'flex';
        setTimeout(() => linkTicketSearch.focus(), 100);
    }

    function closeLinkTicketModal() {
        linkTicketModal.style.display = 'none';
        currentEmailForLink = null;
        selectedTicketForLink = null;
    }

    function selectTicketForLink(ticket) {
        selectedTicketForLink = ticket;
        linkTicketSearch.value = `#${ticket.id} - ${ticket.subject}`;
        
        let detailsHtml = `<strong>ID:</strong> #${ticket.id}<br>`;
        detailsHtml += `<strong>Progetto:</strong> ${ticket.project ? ticket.project.name : 'N/A'}<br>`;
        detailsHtml += `<strong>Oggetto:</strong> ${ticket.subject}<br>`;
        if (ticket.assigned_to) {
            detailsHtml += `<strong>Assegnato a:</strong> ${ticket.assigned_to.name}<br>`;
        }
        
        selectedTicketDetails.innerHTML = detailsHtml;
        selectedTicketPreview.classList.remove('d-none');
        confirmLinkTicketBtn.disabled = false;
    }

    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function renderAutocompleteSuggestions(tickets, query = '') {
        linkTicketAutocompleteList.innerHTML = '';
        
        if (tickets.length === 0) {
            const noResults = document.createElement('div');
            noResults.className = 'autocomplete-suggestion-item text-muted';
            noResults.textContent = 'Nessun ticket trovato';
            linkTicketAutocompleteList.appendChild(noResults);
            linkTicketAutocompleteList.style.display = 'block';
            return;
        }
        
        const limit = 20;
        const visibleTickets = tickets.slice(0, limit);
        
        visibleTickets.forEach(ticket => {
            const item = document.createElement('div');
            item.className = 'autocomplete-suggestion-item';
            
            const emailCleanSubject = cleanSubjectForComparison(currentEmailForLink ? currentEmailForLink.subject : '');
            const ticketCleanSubject = cleanSubjectForComparison(ticket.subject);
            const isSuggested = emailCleanSubject && emailCleanSubject === ticketCleanSubject;
            
            if (isSuggested) {
                item.classList.add('suggested-match');
            }
            
            const titleSpan = document.createElement('div');
            titleSpan.className = 'suggestion-title';
            if (query) {
                const regex = new RegExp(`(${escapeRegExp(query)})`, 'gi');
                titleSpan.innerHTML = `#${ticket.id} - ${ticket.subject.replace(regex, '<mark class="p-0">$1</mark>')}`;
            } else {
                titleSpan.textContent = `#${ticket.id} - ${ticket.subject}`;
            }
            item.appendChild(titleSpan);
            
            const metaDiv = document.createElement('div');
            metaDiv.className = 'suggestion-meta';
            
            const projectSpan = document.createElement('span');
            projectSpan.className = 'badge bg-secondary-subtle text-secondary';
            projectSpan.textContent = ticket.project ? ticket.project.name : 'Supporto';
            metaDiv.appendChild(projectSpan);
            
            if (ticket.assigned_to) {
                const assigneeSpan = document.createElement('span');
                assigneeSpan.textContent = `Assegnato a: ${ticket.assigned_to.name}`;
                metaDiv.appendChild(assigneeSpan);
            }
            
            if (isSuggested) {
                const badgeSpan = document.createElement('span');
                badgeSpan.className = 'badge bg-warning text-dark ms-2';
                badgeSpan.innerHTML = '<i class="fa-solid fa-star"></i> Suggerito';
                metaDiv.appendChild(badgeSpan);
            }
            
            item.appendChild(metaDiv);
            
            item.addEventListener('click', () => {
                selectTicketForLink(ticket);
                linkTicketAutocompleteList.style.display = 'none';
            });
            
            linkTicketAutocompleteList.appendChild(item);
        });
        
        linkTicketAutocompleteList.style.display = 'block';
    }

    if (linkTicketSearch) {
        linkTicketSearch.addEventListener('input', () => {
            const query = linkTicketSearch.value.trim().toLowerCase();
            if (!query) {
                linkTicketAutocompleteList.innerHTML = '';
                linkTicketAutocompleteList.style.display = 'none';
                return;
            }
            
            const filtered = openTickets.filter(ticket => {
                const idStr = String(ticket.id);
                const subject = (ticket.subject || '').toLowerCase();
                return idStr.includes(query) || subject.includes(query);
            });
            
            // Ordina spingendo in alto i ticket con oggetto identico (suggeriti)
            const emailCleanSubject = cleanSubjectForComparison(currentEmailForLink ? currentEmailForLink.subject : '');
            filtered.sort((a, b) => {
                const aClean = cleanSubjectForComparison(a.subject);
                const bClean = cleanSubjectForComparison(b.subject);
                const aMatch = aClean === emailCleanSubject ? 1 : 0;
                const bMatch = bClean === emailCleanSubject ? 1 : 0;
                return bMatch - aMatch;
            });
            
            renderAutocompleteSuggestions(filtered, query);
        });

        linkTicketSearch.addEventListener('focus', () => {
            if (linkTicketSearch.value === '' && openTickets.length > 0) {
                // Ordina spingendo in alto i ticket con oggetto identico (suggeriti)
                const emailCleanSubject = cleanSubjectForComparison(currentEmailForLink ? currentEmailForLink.subject : '');
                const sorted = [...openTickets].sort((a, b) => {
                    const aClean = cleanSubjectForComparison(a.subject);
                    const bClean = cleanSubjectForComparison(b.subject);
                    const aMatch = aClean === emailCleanSubject ? 1 : 0;
                    const bMatch = bClean === emailCleanSubject ? 1 : 0;
                    return bMatch - aMatch;
                });
                renderAutocompleteSuggestions(sorted);
            }
        });
    }

    document.addEventListener('click', (e) => {
        if (linkTicketAutocompleteList && linkTicketSearch && e.target !== linkTicketSearch && !linkTicketAutocompleteList.contains(e.target)) {
            linkTicketAutocompleteList.style.display = 'none';
        }
    });

    if (closeLinkTicketBtn) closeLinkTicketBtn.addEventListener('click', closeLinkTicketModal);
    if (cancelLinkTicketBtn) cancelLinkTicketBtn.addEventListener('click', closeLinkTicketModal);

    if (confirmLinkTicketBtn) {
        confirmLinkTicketBtn.addEventListener('click', async () => {
            if (!currentEmailForLink || !selectedTicketForLink) return;
            
            const markAsRead = linkTicketMarkAsRead ? linkTicketMarkAsRead.checked : true;
            
            const relatedIds = [];
            if (markAsRead && currentEmailForLink) {
                const threadId = currentEmailForLink.threadId;
                const subject = currentEmailForLink.subject;
                allEmails.forEach(e => {
                    if ((threadId && e.threadId === threadId) || (!threadId && subject && e.subject === subject) || e.id === currentEmailForLink.id) {
                        if (!relatedIds.includes(e.id)) {
                            relatedIds.push(e.id);
                        }
                    }
                });
                markVisualAsRead(relatedIds);
            }

            confirmLinkTicketBtn.disabled = true;
            confirmLinkTicketBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Collegamento...';
            
            const description = formatTextileDescription(currentEmailForLink);
            
            try {
                const response = await fetch('/api/redmine/update-ticket', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ticketId: selectedTicketForLink.id,
                        emailId: currentEmailForLink.id,
                        notes: description,
                        markAsRead: markAsRead,
                        projectId: selectedTicketForLink.project ? selectedTicketForLink.project.id : null,
                        projectName: selectedTicketForLink.project ? selectedTicketForLink.project.name : null
                    })
                });
                
                if (response.ok) {
                    const linkedTicketId = selectedTicketForLink.id;

                    if (markAsRead && currentEmailForLink) {
                        // Clean up localStorage
                        let savedPinnedIds = [];
                        try {
                            savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
                        } catch (e) {}
                        savedPinnedIds = savedPinnedIds.filter(id => !relatedIds.includes(id));
                        localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));

                        let unpinnedIds = [];
                        try {
                            unpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
                        } catch (e) {}
                        relatedIds.forEach(id => {
                            if (!unpinnedIds.includes(id)) {
                                unpinnedIds.push(id);
                            }
                        });
                        localStorage.setItem('explicitly_unpinned_email_ids', JSON.stringify(unpinnedIds));

                        // Filter and rerender
                        allEmails = allEmails.filter(e => !relatedIds.includes(e.id));
                        rerenderEmails();
                    }

                    closeLinkTicketModal();
                    alert(`Email collegata con successo al ticket #${linkedTicketId} come aggiornamento.`);
                    if (typeof fetchAndDisplayEmails === 'function') {
                        fetchAndDisplayEmails(true);
                    }
                } else {
                    if (markAsRead && currentEmailForLink) {
                        unmarkVisualAsRead(relatedIds);
                    }
                    const errorJson = await response.json();
                    throw new Error(errorJson.message || 'Errore durante l\'aggiornamento del ticket.');
                }
            } catch (err) {
                if (markAsRead && currentEmailForLink) {
                    unmarkVisualAsRead(relatedIds);
                }
                console.error('Catch error:', err);
                alert(`Errore durante il collegamento dell'email al ticket: ${err.message}`);
            } finally {
                confirmLinkTicketBtn.disabled = false;
                confirmLinkTicketBtn.innerHTML = 'Collega ed Aggiorna';
            }
        });
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
    let currentTicketIdForNotification = null;

    function extractCleanEmailsFrontend(fieldValue) {
        if (!fieldValue) return '';
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const matches = fieldValue.match(emailRegex);
        return matches ? matches.join('; ') : '';
    }

    function isValidEmailFrontend(emailStr) {
        if (!emailStr) return false;
        let senderEmail = emailStr;
        const emailMatch = senderEmail.match(/<(.+?)>/);
        if (emailMatch) senderEmail = emailMatch[1];
        senderEmail = senderEmail.trim();
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        return emailRegex.test(senderEmail);
    }

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
        currentTicketIdForNotification = ticketId;

        notificationToInput.value = senderEmail;
        
        // Popolamento e-mail Cc
        const notificationCcInput = document.getElementById('notification-cc');
        if (notificationCcInput) {
            notificationCcInput.value = extractCleanEmailsFrontend(email.cc || "");
        }

        notificationSubjectInput.value = `Presa in carico richiesta | Ticket #${ticketId}`;

        notificationBodyInput.value = `
        <p style="margin: 0 0 16px 0;">
            Gentile utente,
        </p>

        <p style="margin: 0 0 12px 0;">
            ti confermiamo che la tua richiesta "${email.subject || ''}" è stata presa in carico ed è ora gestita con il ticket n. <strong>#${ticketId}</strong>.
        </p>

        <p style="margin: 0 0 12px 0;">
            Ti invitiamo a indicare questo numero di ticket in caso di successive comunicazioni con il servizio di supporto, così da permetterci una gestione più rapida ed efficace della tua segnalazione.
        </p>

        <p style="margin: 24px 0 4px 0;">
            Cordiali saluti,
        </p>
        <div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr"><table style="color:rgb(34,34,34);font-family:'Poppins',sans-serif;font-size:13px"><tbody><tr><td style="vertical-align:top;width:255px;padding-right:15px"><img src="https://ci3.googleusercontent.com/meips/ADKq_NakdLZw3np14DEPBZOPt2kQWv8lxgVYYYdEt65x_rbukNuIdC4HZfnoOm2NiE8CGuDKVV-wJ-skUokO8lQ4OsFbCfFRxHEwO2BPw2BJNkh1uBwJiA=s0-d-e1-ft#http://www.maestrale.it/email-sign/logo-maestrale_MIT.png?10=0" style="max-width:100%;height:auto" class="CToWUd" data-bit="iit"></td><td><p style="margin-bottom:0px;padding-bottom:0px"><span style="color:rgb(0,79,152);font-size:14px"><b>Support Team<br></b></span><span style="color:rgb(102,102,102);font-size:13px">Helpdesk &amp; Support</span></p><p style="font-size:12px;margin:5px 0"></p><h2 style="font-size:12px;margin-bottom:0px;padding-bottom:0px;color:rgb(84,4,9)"><b>MAESTRALE INFORMATION TECHNOLOGY</b></h2><p style="font-size:11px;margin-bottom:0px;padding-bottom:0px;padding-top:0px;margin-top:0px;line-height:1.4"><span style="color:rgb(84,4,9)"><b>a</b></span><font color="#666666">&nbsp;Via Luigi Casale 7 - 05100 Terni (Italy)<br></font><span style="color:rgb(84,4,9)"><b>t</b></span>&nbsp;<span style="color:rgb(102,102,102)">0744 436225&nbsp;</span><span style="color:rgb(84,4,9)"><b>&nbsp;f</b></span>&nbsp;<font color="#666666">0744 431944<br></font><span style="color:rgb(84,4,9)"><b>w</b></span>&nbsp;<a href="http://www.maestrale.it/" style="color:rgb(102,102,102)" target="_blank" data-saferedirecturl="https://www.google.com/url?q=http://www.maestrale.it/&amp;source=gmail&amp;ust=1781332864985000&amp;usg=AOvVaw1DYqwWRacXqWPvJ6qMqdiN">www.maestrale.it</a>&nbsp;</p><p style="margin-top:5px"><a href="https://www.facebook.com/gruppomaestrale" style="color:rgb(17,85,204)" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://www.facebook.com/gruppomaestrale&amp;source=gmail&amp;ust=1781332864985000&amp;usg=AOvVaw1fSXMTSKqlc4A2mLSIP21V"><img src="https://ci3.googleusercontent.com/meips/ADKq_NaKfK3L8yY6uScfZvTGUl6UZVZAodJOrywf70NsRPvIkI3mVr9con35lKMUf2XAOnUkCnVhKYRGOz6Jg-0r5THm2Ys5yqofaiwz=s0-d-e1-ft#http://www.maestrale.it/email-sign/social/fb.png?1=0" class="CToWUd" data-bit="iit"></a>&nbsp;<a href="https://twitter.com/GruppoMaestrale" style="color:rgb(17,85,204)" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://twitter.com/GruppoMaestrale&amp;source=gmail&amp;ust=1781332864985000&amp;usg=AOvVaw05yOm9fC3nS7sfP6z4oCwD"><img src="https://ci3.googleusercontent.com/meips/ADKq_NbQs_27dZpcSzDtedkgh3etCgrQ9w_2srSGaS9S4JAIUhxbb4j9D76NBKs3njlYbMWcxhWGS7071R3jQMYINo9mo_KjWuw2CqLM=s0-d-e1-ft#http://www.maestrale.it/email-sign/social/tw.png?1=0" class="CToWUd" data-bit="iit"></a>&nbsp;<a href="https://www.linkedin.com/company/9210389/admin/" style="color:rgb(17,85,204)" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://www.linkedin.com/company/9210389/admin/&amp;source=gmail&amp;ust=1781332864985000&amp;usg=AOvVaw1SzNAmiV_e3J5BqWkwism-"><img src="https://ci3.googleusercontent.com/meips/ADKq_NZSOZLZuGUxuF0OgfnrOt2Y6OF9UAdHWuUJWpb4FeaDX9zDXg2wxXmVKtWwLCBhQHt_Fdb_247YCsgL6QamEw3enmTnfSfIVH02=s0-d-e1-ft#http://www.maestrale.it/email-sign/social/li.png?1=0" class="CToWUd" data-bit="iit"></a>&nbsp;<a href="https://www.youtube.com/channel/UCEg5aHL5mKonU_JbA0pJXhw?view_as=subscriber" style="color:rgb(17,85,204)" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://www.youtube.com/channel/UCEg5aHL5mKonU_JbA0pJXhw?view_as%3Dsubscriber&amp;source=gmail&amp;ust=1781332864985000&amp;usg=AOvVaw3g6pjz_sX-hTnhWOFDwWz-"><img src="https://ci3.googleusercontent.com/meips/ADKq_NavDnRe5qkEexXOJFYfrZsVdMouNpEXiQQnhzt_iuCzSsJ2RMIOUvbwbGUrDMWiDeZuQ_tYytD2WYh657vjWvyA6bzAvGXS0rfD=s0-d-e1-ft#http://www.maestrale.it/email-sign/social/yt.png?1=0" class="CToWUd" data-bit="iit"></a></p></td></tr></tbody></table></div></div>
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
            const notificationCcInput = document.getElementById('notification-cc');
            const cc = notificationCcInput ? notificationCcInput.value : '';
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
                        cc,
                        subject,
                        body,
                        threadId: currentThreadIdForNotification,
                        ticketId: currentTicketIdForNotification
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

    // --- Keyboard Shortcuts & Modals Close Handler ---
    document.addEventListener('keydown', (e) => {
        // 1. Ctrl+A / Cmd+A: Select All Emails in current tab
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            const activeElem = document.activeElement;
            const isEditable = activeElem && (
                activeElem.tagName === 'INPUT' || 
                activeElem.tagName === 'TEXTAREA' || 
                activeElem.isContentEditable
            );
            if (!isEditable) {
                e.preventDefault();
                const selectAllCheckbox = document.getElementById('select-all-checkbox');
                if (selectAllCheckbox) {
                    selectAllCheckbox.checked = true;
                    selectAllCheckbox.dispatchEvent(new Event('change'));
                }
            }
        }

        // 2. Ctrl+Enter / Cmd+Enter: Send Email / Send Notification
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            // Reply modal open check
            const replyModalEl = document.getElementById('replyModal');
            if (replyModalEl && replyModalEl.style.display === 'block') {
                e.preventDefault();
                const sendReplyBtn = document.getElementById('send-reply-btn');
                if (sendReplyBtn && !sendReplyBtn.disabled) {
                    sendReplyBtn.click();
                }
                return;
            }

            // Ticket notification modal open check
            const notificationModal = document.getElementById('ticket-notification-modal');
            if (notificationModal && notificationModal.style.display === 'flex') {
                e.preventDefault();
                const sendNotificationBtn = document.getElementById('send-notification');
                if (sendNotificationBtn && !sendNotificationBtn.disabled) {
                    sendNotificationBtn.click();
                }
                return;
            }
        }

        // 3. Escape: Close open modals and context menu
        if (e.key === 'Escape') {
            if (typeof closeContextMenu === 'function') {
                closeContextMenu();
            }

            const fullEmailModal = document.getElementById('full-email-modal');
            if (fullEmailModal && fullEmailModal.style.display === 'flex') {
                if (typeof closeFullScreenEmail === 'function') {
                    closeFullScreenEmail();
                }
            }

            const replyModalEl = document.getElementById('replyModal');
            if (replyModalEl && replyModalEl.style.display === 'block') {
                if (typeof closeReplyModal === 'function') {
                    closeReplyModal();
                }
            }

            const notificationModal = document.getElementById('ticket-notification-modal');
            if (notificationModal && notificationModal.style.display === 'flex') {
                if (typeof closeNotificationModal === 'function') {
                    closeNotificationModal();
                }
            }
        }
    });

    const toggleCalendarPanelButton = document.getElementById('toggle-calendar-panel');
    const calendarPanel = document.getElementById('calendar-panel');

    if (toggleCalendarPanelButton && calendarPanel) {
        toggleCalendarPanelButton.addEventListener('click', () => {
            calendarPanel.classList.toggle('open');
        });
    }

    // --- Sent Emails Panel Logic ---
    const sentEmailsPanel = document.getElementById('sent-emails-panel');
    const toggleSentEmailsPanelBtn = document.getElementById('toggle-sent-emails-panel');
    const closeSentEmailsPanelBtn = document.getElementById('close-sent-emails-panel');
    const refreshSentEmailsBtn = document.getElementById('refresh-sent-emails-btn');
    const sentEmailsSearch = document.getElementById('sent-emails-search');
    const sentEmailsList = document.getElementById('sent-emails-list');

    let cachedSentEmails = [];

    if (toggleSentEmailsPanelBtn && sentEmailsPanel) {
        toggleSentEmailsPanelBtn.addEventListener('click', () => {
            sentEmailsPanel.classList.toggle('open');
            if (sentEmailsPanel.classList.contains('open')) {
                fetchSentEmails();
            }
        });
    }

    if (closeSentEmailsPanelBtn && sentEmailsPanel) {
        closeSentEmailsPanelBtn.addEventListener('click', () => {
            sentEmailsPanel.classList.remove('open');
        });
    }

    if (refreshSentEmailsBtn) {
        refreshSentEmailsBtn.addEventListener('click', fetchSentEmails);
    }

    if (sentEmailsSearch) {
        sentEmailsSearch.addEventListener('input', () => {
            const query = sentEmailsSearch.value.toLowerCase().trim();
            filterAndRenderSentEmails(query);
        });
    }

    async function fetchSentEmails() {
        try {
            if (refreshSentEmailsBtn) {
                const icon = refreshSentEmailsBtn.querySelector('i');
                if (icon) icon.classList.add('fa-spin');
            }
            const response = await fetch('/api/sent-emails');
            if (!response.ok) throw new Error('Impossibile recuperare le email inviate');
            cachedSentEmails = await response.json();
            const query = sentEmailsSearch ? sentEmailsSearch.value.toLowerCase().trim() : '';
            filterAndRenderSentEmails(query);
        } catch (error) {
            console.error('Errore nel caricamento delle email inviate:', error);
        } finally {
            if (refreshSentEmailsBtn) {
                const icon = refreshSentEmailsBtn.querySelector('i');
                if (icon) icon.classList.remove('fa-spin');
            }
        }
    }

    function filterAndRenderSentEmails(query = '') {
        if (!sentEmailsList) return;
        
        let filtered = cachedSentEmails;
        if (query) {
            filtered = cachedSentEmails.filter(email => {
                const subject = (email.subject || '').toLowerCase();
                const body = (email.body || '').toLowerCase();
                const to = (email.to || '').toLowerCase();
                const cc = (email.cc || '').toLowerCase();
                const bcc = (email.bcc || '').toLowerCase();
                const sentBy = (email.sentBy || '').toLowerCase();
                return subject.includes(query) || body.includes(query) || to.includes(query) || cc.includes(query) || bcc.includes(query) || sentBy.includes(query);
            });
        }
        
        renderSentEmails(filtered);
    }

    function renderSentEmails(emails) {
        if (!sentEmailsList) return;
        
        if (emails.length === 0) {
            sentEmailsList.innerHTML = `<div class="text-center text-muted py-4" style="font-size: 0.85rem;">Nessuna email inviata trovata.</div>`;
            return;
        }

        sentEmailsList.innerHTML = '';
        
        emails.forEach(email => {
            const item = document.createElement('div');
            item.className = 'sent-email-item';
            
            // Definisce classe badge e testo per il tipo
            let badgeClass = 'badge-risposta';
            let typeText = 'Risposta';
            let typeIcon = 'fa-reply';
            if (email.type === 'apertura_ticket') {
                badgeClass = 'badge-apertura';
                typeText = 'Apertura Ticket';
                typeIcon = 'fa-ticket';
            } else if (email.type === 'chiusura_ticket') {
                badgeClass = 'badge-chiusura';
                typeText = 'Chiusura Ticket';
                typeIcon = 'fa-circle-check';
            } else if (email.type === 'inoltro') {
                badgeClass = 'badge-inoltro';
                typeText = 'Inoltro';
                typeIcon = 'fa-share';
            }

            const formattedDate = new Date(email.timestamp).toLocaleString('it-IT');
            const ticketTag = email.ticketId ? `<span class="badge bg-secondary ms-1">#${email.ticketId}</span>` : '';

            item.innerHTML = `
                <div class="sent-email-header">
                    <div class="sent-email-meta">
                        <span class="badge ${badgeClass}"><i class="fa-solid ${typeIcon} me-1"></i>${typeText}</span>
                        <span>${formattedDate}</span>
                    </div>
                    <h4 class="sent-email-subject">${email.subject} ${ticketTag}</h4>
                    <div class="sent-email-recipients">
                        <strong>A:</strong> ${email.to}
                        ${email.cc ? `<br><strong>Cc:</strong> ${email.cc}` : ''}
                        ${email.bcc ? `<br><strong>Bcc:</strong> ${email.bcc}` : ''}
                    </div>
                    <div class="sent-email-meta mt-1">
                        <span>Mittente: <strong>${email.sentBy}</strong></span>
                        <i class="fa-solid fa-chevron-down text-muted collapse-indicator"></i>
                    </div>
                </div>
                <div class="sent-email-body-container">
                    <div class="sent-email-body"></div>
                </div>
            `;

            const header = item.querySelector('.sent-email-header');
            const container = item.querySelector('.sent-email-body-container');
            const indicator = item.querySelector('.collapse-indicator');

            header.addEventListener('click', () => {
                const isExpanded = container.classList.contains('expanded');
                if (isExpanded) {
                    container.classList.remove('expanded');
                    indicator.classList.remove('fa-chevron-up');
                    indicator.classList.add('fa-chevron-down');
                } else {
                    const bodyDiv = container.querySelector('.sent-email-body');
                    if (bodyDiv && bodyDiv.innerHTML === '') {
                        const cleanBody = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(email.body) : email.body;
                        bodyDiv.innerHTML = cleanBody;
                    }
                    container.classList.add('expanded');
                    indicator.classList.remove('fa-chevron-down');
                    indicator.classList.add('fa-chevron-up');
                }
            });

            sentEmailsList.appendChild(item);
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

    async function checkForSmartSupportSuggestion(email, description) {
        if (!email) return description;
        try {
            const response = await fetch('/api/smartsupport/assist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    emailId: email.id,
                    subject: email.subject,
                    body: email.body,
                    client: email.projectName
                })
            });
            if (response.ok) {
                const data = await response.json();
                if (data.status === 'success' && (data.matchType === 'high' || data.matchType === 'medium')) {
                    // Puliamo i tag HTML per la visualizzazione nella popup confirm
                    const cleanTextForPopup = data.responseText
                        .replace(/<br\s*\/?>/gi, '\n')
                        .replace(/<\/?[^>]+(>|$)/g, ''); // rimuove tutti i tag HTML
                    
                    const addSuggestion = confirm(`Ho trovato questo suggerimento per la risoluzione del ticket:\n\n${cleanTextForPopup}\n\nVuoi aggiungerlo al ticket?`);
                    if (addSuggestion) {
                        // Formatta in formato Textile per Redmine
                        let textileSuggestion = data.responseText
                            .replace(/<br\s*\/?>/gi, '\n')
                            // Sostituiamo i tag <a> con i link Textile: "testo":url
                            .replace(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '"$2":$1')
                            // Rimuove gli altri tag HTML (es. <strong>, <ul>, <li>, ecc.)
                            .replace(/<\/?[^>]+(>|$)/g, '');
                        
                        return description + `\n\n*SmartSupport AI Advisor:*\n${textileSuggestion}`;
                    }
                }
            }
        } catch (err) {
            console.error('Errore durante la ricerca automatica dei suggerimenti SmartSupport:', err);
        }
        return description;
    }

    async function assignToLevel1(email, button) {
        if (!email) return;

        if (!email.body && !email.bodyHtml) {
            try {
                const res = await fetch(`/api/emails/${email.id}`);
                if (!res.ok) throw new Error('Errore di rete');
                const fullEmail = await res.json();
                Object.assign(email, fullEmail);
            } catch (err) {
                console.error(err);
                alert("Impossibile caricare i dettagli dell'email per l'assegnazione L1: " + err.message);
                return;
            }
        }

        const markAsRead = confirm("Vuoi contrassegnare l'email come letta?");

        const relatedIds = [];
        if (markAsRead) {
            const threadId = email.threadId;
            const subject = email.subject;
            allEmails.forEach(e => {
                if ((threadId && e.threadId === threadId) || (!threadId && subject && e.subject === subject) || e.id === email.id) {
                    if (!relatedIds.includes(e.id)) {
                        relatedIds.push(e.id);
                    }
                }
            });
            markVisualAsRead(relatedIds);
        }

        const originalText = button.innerHTML;
        button.disabled = true;
        button.classList.add('loading');
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

        let description = formatTextileDescription(email);
        description = await checkForSmartSupportSuggestion(email, description);

        try {
            const response = await fetch('/api/redmine/create-ticket', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    emailId: email.id,
                    projectId: 7291, // Maestrale Cloud
                    projectName: "Supporto LVL 1",
                    subject: email.subject,
                    description: description,
                    priorityId: 2, // Normale
                    assignedToId: 1021, // SysAdmin Livello 1
                    markAsRead
                })
            });

            if (response.ok) {
                const result = await response.json();
                const ticketId = result.ticketId;
                button.innerHTML = '<i class="fa-solid fa-check"></i> OK';
                button.classList.remove('btn-outline-primary');
                button.classList.add('btn-success');

                if (markAsRead) {
                    // Clean up localStorage
                    let savedPinnedIds = [];
                    try {
                        savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
                    } catch (e) {}
                    savedPinnedIds = savedPinnedIds.filter(id => !relatedIds.includes(id));
                    localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));

                    let unpinnedIds = [];
                    try {
                        unpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
                    } catch (e) {}
                    relatedIds.forEach(id => {
                        if (!unpinnedIds.includes(id)) {
                            unpinnedIds.push(id);
                        }
                    });
                    localStorage.setItem('explicitly_unpinned_email_ids', JSON.stringify(unpinnedIds));

                    // Filter and rerender
                    allEmails = allEmails.filter(e => !relatedIds.includes(e.id));
                    rerenderEmails();
                }

                setTimeout(() => {
                    // Ricarica le email in background per aggiornare lo stato del ticket
                    if (typeof fetchAndDisplayEmails === 'function') {
                        fetchAndDisplayEmails(true);
                    }
                }, 1500);

                // Prompt for notification (skip if bot or email not valid)
                if (email && email.category !== 'Bot' && isValidEmailFrontend(email.from)) {
                    setTimeout(() => {
                        if (confirm(`Ticket #${ticketId} creato con successo. Vuoi inviare la notifica via email al mittente?`)) {
                            openNotificationModal(ticketId, email);
                        }
                    }, 500);
                } else {
                    setTimeout(() => {
                        alert(`Ticket #${ticketId} creato con successo!`);
                    }, 500);
                }
            } else {
                if (markAsRead) {
                    unmarkVisualAsRead(relatedIds);
                }
                const error = await response.json();
                throw new Error(error.message || 'Errore creazione ticket');
            }
        } catch (err) {
            if (markAsRead) {
                unmarkVisualAsRead(relatedIds);
            }
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

    async function assignToLevel2(email, button) {
        if (!email) return;

        if (!email.body && !email.bodyHtml) {
            try {
                const res = await fetch(`/api/emails/${email.id}`);
                if (!res.ok) throw new Error('Errore di rete');
                const fullEmail = await res.json();
                Object.assign(email, fullEmail);
            } catch (err) {
                console.error(err);
                alert("Impossibile caricare i dettagli dell'email per l'assegnazione L2: " + err.message);
                return;
            }
        }

        const markAsRead = confirm("Vuoi contrassegnare l'email come letta?");

        const relatedIds = [];
        if (markAsRead) {
            const threadId = email.threadId;
            const subject = email.subject;
            allEmails.forEach(e => {
                if ((threadId && e.threadId === threadId) || (!threadId && subject && e.subject === subject) || e.id === email.id) {
                    if (!relatedIds.includes(e.id)) {
                        relatedIds.push(e.id);
                    }
                }
            });
            markVisualAsRead(relatedIds);
        }

        const originalText = button.innerHTML;
        button.disabled = true;
        button.classList.add('loading');
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

        let description = formatTextileDescription(email);
        description = await checkForSmartSupportSuggestion(email, description);

        try {
            const response = await fetch('/api/redmine/create-ticket', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    emailId: email.id,
                    projectId: 7312, // L2 Support
                    projectName: "Supporto LVL 2",
                    subject: email.subject,
                    description: description,
                    priorityId: 2, // Normale
                    assignedToId: 1022, // SysAdmin Livello 2
                    markAsRead
                })
            });

            if (response.ok) {
                const result = await response.json();
                const ticketId = result.ticketId;
                button.innerHTML = '<i class="fa-solid fa-check"></i> OK';
                button.classList.remove('btn-outline-primary');
                button.classList.add('btn-success');

                if (markAsRead) {
                    // Clean up localStorage
                    let savedPinnedIds = [];
                    try {
                        savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
                    } catch (e) {}
                    savedPinnedIds = savedPinnedIds.filter(id => !relatedIds.includes(id));
                    localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));

                    let unpinnedIds = [];
                    try {
                        unpinnedIds = JSON.parse(localStorage.getItem('explicitly_unpinned_email_ids')) || [];
                    } catch (e) {}
                    relatedIds.forEach(id => {
                        if (!unpinnedIds.includes(id)) {
                            unpinnedIds.push(id);
                        }
                    });
                    localStorage.setItem('explicitly_unpinned_email_ids', JSON.stringify(unpinnedIds));

                    // Filter and rerender
                    allEmails = allEmails.filter(e => !relatedIds.includes(e.id));
                    rerenderEmails();
                }

                setTimeout(() => {
                    // Ricarica le email in background per aggiornare lo stato del ticket
                    if (typeof fetchAndDisplayEmails === 'function') {
                        fetchAndDisplayEmails(true);
                    }
                }, 1500);

                // Prompt for notification (skip if bot or email not valid)
                if (email && email.category !== 'Bot' && isValidEmailFrontend(email.from)) {
                    setTimeout(() => {
                        if (confirm(`Ticket #${ticketId} creato con successo. Vuoi inviare la notifica via email al mittente?`)) {
                            openNotificationModal(ticketId, email);
                        }
                    }, 500);
                } else {
                    setTimeout(() => {
                        alert(`Ticket #${ticketId} creato con successo!`);
                    }, 500);
                }
            } else {
                if (markAsRead) {
                    unmarkVisualAsRead(relatedIds);
                }
                const error = await response.json();
                throw new Error(error.message || 'Errore creazione ticket');
            }
        } catch (err) {
            if (markAsRead) {
                unmarkVisualAsRead(relatedIds);
            }
            console.error('Error assigning to L2:', err);
            button.innerHTML = '<i class="fa-solid fa-xmark"></i> Err';
            button.classList.add('btn-danger');
            setTimeout(() => {
                button.disabled = false;
                button.classList.remove('loading', 'btn-danger');
                button.innerHTML = originalText;
            }, 3000);
        }
    }


    // ==========================================================================
    // CRONOLOGIA ATTIVITÀ (ACTIVITY HISTORY) FRONTEND LOGIC
    // ==========================================================================
    
    let currentActivityPage = 1;
    const activityLimit = 50;
    let activitySearchTimeout = null;

    async function fetchAndDisplayActivities(page = 1) {
        currentActivityPage = page;
        const searchInput = document.getElementById('activity-search-input');
        const typeFilter = document.getElementById('activity-type-filter');
        const listContainer = document.getElementById('activity-list-container');
        const pageInfo = document.getElementById('activity-page-info');
        const prevBtn = document.getElementById('activity-prev-page');
        const nextBtn = document.getElementById('activity-next-page');

        if (!listContainer) return;

        listContainer.innerHTML = '<div class="text-center p-5"><span class="spinner-border text-primary"></span><p class="mt-2 text-muted">Caricamento attività...</p></div>';

        const search = searchInput ? encodeURIComponent(searchInput.value) : '';
        const type = typeFilter ? typeFilter.value : '';

        try {
            const res = await fetch(`/api/activity-log?page=${page}&limit=${activityLimit}&search=${search}&type=${type}`);
            if (!res.ok) throw new Error('Errore durante il recupero dei log attività');
            const data = await res.json();

            renderActivities(data.activities);

            // Aggiorna controlli di paginazione
            if (pageInfo) {
                pageInfo.textContent = `Pagina ${data.page} di ${data.totalPages || 1}`;
            }
            if (prevBtn) {
                prevBtn.disabled = data.page <= 1;
            }
            if (nextBtn) {
                nextBtn.disabled = data.page >= data.totalPages;
            }
        } catch (error) {
            console.error('Errore nel caricamento dei log attività:', error);
            listContainer.innerHTML = `<div class="alert alert-danger m-3">Si è verificato un errore nel caricamento delle attività: ${error.message}</div>`;
        }
    }

    function formatActivityDay(dateString) {
        const date = new Date(dateString);
        const today = new Date();
        const yesterday = new Date();
        yesterday.setDate(today.getDate() - 1);

        if (date.toDateString() === today.toDateString()) {
            return "Oggi";
        } else if (date.toDateString() === yesterday.toDateString()) {
            return "Ieri";
        } else {
            // Formato: Giovedì, 21 maggio
            const options = { weekday: 'long', day: 'numeric', month: 'long' };
            let formatted = date.toLocaleDateString('it-IT', options);
            // Capitalize first letter
            return formatted.charAt(0).toUpperCase() + formatted.slice(1);
        }
    }

    function groupConsecutiveEmailReads(activitiesList) {
        const grouped = [];
        let i = 0;

        while (i < activitiesList.length) {
            const current = activitiesList[i];

            // Se è un email_read, controlliamo se ci sono email_read consecutivi dello stesso utente nello stesso giorno
            if (current.type === 'email_read') {
                const group = [current];
                let j = i + 1;
                const currentDay = new Date(current.timestamp).toDateString();
                const currentUser = current.userId;

                while (j < activitiesList.length) {
                    const next = activitiesList[j];
                    const nextDay = new Date(next.timestamp).toDateString();
                    
                    if (next.type === 'email_read' && next.userId === currentUser && nextDay === currentDay) {
                        group.push(next);
                        j++;
                    } else {
                        break;
                    }
                }

                if (group.length > 1) {
                    // Abbiamo un gruppo di letture consecutive
                    grouped.push({
                        isGrouped: true,
                        userId: currentUser,
                        type: 'email_read',
                        timestamp: current.timestamp,
                        activities: group,
                        description: `${currentUser} ha letto ${group.length} email.`
                    });
                    i = j; // salta i raggruppati
                } else {
                    grouped.push(current);
                    i++;
                }
            } else {
                grouped.push(current);
                i++;
            }
        }

        return grouped;
    }

    function isUndoable(type) {
        const undoableTypes = [
            'email_read',
            'email_moved',
            'backup_source_created',
            'backup_source_deleted',
            'backup_source_updated',
            'email_pinned',
            'email_unpinned',
            'ticket_created'
        ];
        return undoableTypes.includes(type);
    }

    function renderActivities(rawActivities) {
        const listContainer = document.getElementById('activity-list-container');
        if (!listContainer) return;

        if (!rawActivities || rawActivities.length === 0) {
            listContainer.innerHTML = '<div class="text-center p-5 text-muted"><i class="fa-solid fa-clock-rotate-left fa-3x mb-3 text-secondary"></i><p>Nessun evento registrato nella cronologia attività.</p></div>';
            return;
        }

        const groupedActivities = groupConsecutiveEmailReads(rawActivities);

        // Raggruppiamo per giorno (es. "Oggi", "Ieri", "Giovedì, 21 maggio")
        const dayGroups = {};
        groupedActivities.forEach(act => {
            const dayKey = formatActivityDay(act.timestamp);
            if (!dayGroups[dayKey]) {
                dayGroups[dayKey] = [];
            }
            dayGroups[dayKey].push(act);
        });

        let html = '';
        for (const [day, acts] of Object.entries(dayGroups)) {
            html += `
                <div class="activity-day-group">
                    <div class="activity-day-header">${DOMPurify.sanitize(day)}</div>
            `;

            acts.forEach(act => {
                const time = new Date(act.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                
                if (act.isGrouped) {
                    // Gruppo letture email
                    const groupId = `group_${act.timestamp.replace(/[^0-9]/g, '')}_${Math.floor(Math.random()*1000)}`;
                    
                    html += `
                        <div class="activity-item" data-type="email_read">
                            <div class="activity-marker"></div>
                            <div class="activity-grouped-container" id="${groupId}">
                                <div class="activity-grouped-header" onclick="document.getElementById('${groupId}').classList.toggle('expanded')">
                                    <div class="d-flex align-items-center gap-2">
                                        <i class="fa-solid fa-envelope-open text-primary me-2"></i>
                                        <span class="activity-desc">${DOMPurify.sanitize(act.description)}</span>
                                    </div>
                                    <div class="d-flex align-items-center gap-3">
                                        <span class="activity-time">${time}</span>
                                        <i class="fa-solid fa-chevron-down activity-grouped-trigger-icon text-muted"></i>
                                    </div>
                                </div>
                                <div class="activity-grouped-details">
                        `;

                    act.activities.forEach(subAct => {
                        const subTime = new Date(subAct.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                        const subject = subAct.details?.subject || 'Senza oggetto';
                        const from = subAct.details?.from || 'Sconosciuto';
                        
                        html += `
                            <div class="activity-sub-item d-flex align-items-center justify-content-between">
                                <div class="d-flex flex-column min-width-0 flex-grow-1">
                                    <span class="activity-sub-desc fw-semibold text-truncate">${DOMPurify.sanitize(subject)}</span>
                                    <span class="text-muted text-truncate" style="font-size: 0.75rem;">da ${DOMPurify.sanitize(from)}</span>
                                </div>
                                <div class="d-flex align-items-center gap-2 ms-2 flex-shrink-0">
                                    <span class="activity-time">${subTime}</span>
                                    <button class="btn btn-xs btn-outline-warning btn-activity-undo" title="Annulla operazione" data-activity-id="${subAct.id}">
                                        <i class="fa-solid fa-rotate-left"></i> Annulla
                                    </button>
                                </div>
                            </div>
                        `;
                    });

                    html += `
                                </div>
                            </div>
                        </div>
                    `;
                } else {
                    // Singola attività
                    let iconHtml = '<i class="fa-solid fa-circle-info text-secondary me-2"></i>';
                    if (act.type === 'login') {
                        iconHtml = '<i class="fa-solid fa-right-to-bracket text-success me-2"></i>';
                    } else if (act.type === 'logout') {
                        iconHtml = '<i class="fa-solid fa-right-from-bracket text-warning me-2"></i>';
                    } else if (act.type === 'email_read') {
                        iconHtml = '<i class="fa-solid fa-envelope-open text-primary me-2"></i>';
                    } else if (act.type === 'email_moved') {
                        iconHtml = '<i class="fa-solid fa-arrow-right-arrow-left text-info me-2"></i>';
                    } else if (act.type === 'ticket_created') {
                        iconHtml = '<i class="fa-solid fa-ticket text-danger me-2"></i>';
                    } else if (act.type === 'archive') {
                        iconHtml = '<i class="fa-solid fa-box-archive text-warning me-2"></i>';
                    } else if (act.type === 'email_pinned') {
                        iconHtml = '<i class="fa-solid fa-thumbtack text-warning me-2"></i>';
                    } else if (act.type === 'email_unpinned') {
                        iconHtml = '<i class="fa-solid fa-thumbtack-slash text-secondary me-2"></i>';
                    } else if (act.type === 'undo') {
                        iconHtml = '<i class="fa-solid fa-rotate-left text-info me-2"></i>';
                    }

                    html += `
                        <div class="activity-item" data-type="${act.type}">
                            <div class="activity-marker"></div>
                            <div class="activity-card d-flex align-items-center justify-content-between">
                                <div class="activity-info min-width-0 flex-grow-1">
                                    <div class="d-flex align-items-center">
                                        ${iconHtml}
                                        <p class="activity-desc">${DOMPurify.sanitize(act.description)}</p>
                                    </div>
                                    ${act.details && act.details.subject ? `
                                        <div class="text-muted text-truncate mt-1 ms-4" style="font-size: 0.8rem; font-style: italic;">
                                            Oggetto: "${DOMPurify.sanitize(act.details.subject)}"
                                        </div>
                                    ` : ''}
                                    ${act.details && act.details.projectName ? `
                                        <div class="text-muted text-truncate mt-1 ms-4" style="font-size: 0.8rem;">
                                            Progetto: <strong>${DOMPurify.sanitize(act.details.projectName)}</strong> | Assegnato a: ${DOMPurify.sanitize(act.details.assignedToName || 'Nessuno')}
                                        </div>
                                    ` : ''}
                                </div>
                                <div class="d-flex align-items-center gap-3 ms-2 flex-shrink-0">
                                    <span class="activity-time">${time}</span>
                                    ${isUndoable(act.type) ? `
                                        <button class="btn btn-xs btn-outline-warning btn-activity-undo" title="Annulla operazione" data-activity-id="${act.id}">
                                            <i class="fa-solid fa-rotate-left"></i> Annulla
                                        </button>
                                    ` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                }
            });

            html += `</div>`;
        }

        listContainer.innerHTML = html;
    }

    // --- Bindings eventi per la Cronologia Attività ---
    const activitySearchInput = document.getElementById('activity-search-input');
    const activityTypeFilter = document.getElementById('activity-type-filter');
    const clearActivitiesBtn = document.getElementById('clear-activities-btn');
    const activityPrevBtn = document.getElementById('activity-prev-page');
    const activityNextBtn = document.getElementById('activity-next-page');
    const activityListContainer = document.getElementById('activity-list-container');

    if (activityListContainer) {
        activityListContainer.addEventListener('click', async (e) => {
            const undoBtn = e.target.closest('.btn-activity-undo');
            if (undoBtn) {
                const activityId = undoBtn.dataset.activityId;
                if (!activityId) return;

                if (!confirm("Sei sicuro di voler annullare questa operazione?")) {
                    return;
                }

                // Show loading spinner on button
                const originalHtml = undoBtn.innerHTML;
                undoBtn.disabled = true;
                undoBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

                try {
                    const res = await fetch('/api/activity-log/undo', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ activityId })
                    });

                    if (!res.ok) {
                        const err = await res.json();
                        throw new Error(err.message || "Errore durante l'operazione di undo");
                    }

                    const data = await res.json();

                    // Client-side undo for local storage pin/unpin states
                    if (data.clientAction === 'unpin' && data.emailId) {
                        let savedPinnedIds = [];
                        try {
                            savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
                        } catch (ex) {}
                        savedPinnedIds = savedPinnedIds.filter(id => id !== data.emailId);
                        localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));
                    } else if (data.clientAction === 'pin' && data.emailId) {
                        let savedPinnedIds = [];
                        try {
                            savedPinnedIds = JSON.parse(localStorage.getItem('pinned_email_ids')) || [];
                        } catch (ex) {}
                        if (!savedPinnedIds.includes(data.emailId)) {
                            savedPinnedIds.push(data.emailId);
                        }
                        localStorage.setItem('pinned_email_ids', JSON.stringify(savedPinnedIds));
                    }

                    // Refresh Activity Timeline
                    fetchAndDisplayActivities(currentActivityPage);

                    // Refresh Emails if needed
                    if (data.refreshEmails) {
                        if (typeof fetchAndDisplayEmails === 'function') {
                            fetchAndDisplayEmails(true);
                        }
                    }

                    // Refresh Backup Hub if needed
                    if (data.refreshBackup) {
                        if (window.refreshBackupHub) {
                            window.refreshBackupHub();
                        }
                    }

                    // Refresh Redmine Dashboard if needed
                    if (data.refreshRedmine) {
                        if (typeof loadRedmineDashboard === 'function') {
                            loadRedmineDashboard();
                        }
                    }

                } catch (error) {
                    console.error("Errore undo:", error);
                    alert(`Impossibile annullare l'operazione: ${error.message}`);
                    undoBtn.disabled = false;
                    undoBtn.innerHTML = originalHtml;
                }
            }
        });
    }

    if (activitySearchInput) {
        activitySearchInput.addEventListener('input', () => {
            clearTimeout(activitySearchTimeout);
            activitySearchTimeout = setTimeout(() => {
                fetchAndDisplayActivities(1);
            }, 300);
        });
    }

    if (activityTypeFilter) {
        activityTypeFilter.addEventListener('change', () => {
            fetchAndDisplayActivities(1);
        });
    }

    if (clearActivitiesBtn) {
        clearActivitiesBtn.addEventListener('click', async () => {
            if (confirm('Sei sicuro di voler archiviare manualmente tutta la cronologia attività corrente? L\'elenco attivo verrà svuotato.')) {
                try {
                    clearActivitiesBtn.disabled = true;
                    clearActivitiesBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Archiviazione...';
                    
                    const res = await fetch('/api/activity-log/archive', { method: 'POST' });
                    if (!res.ok) throw new Error('Errore durante l\'archiviazione');
                    const data = await res.json();
                    
                    alert(data.message || 'Archiviazione completata.');
                    fetchAndDisplayActivities(1);
                } catch (err) {
                    console.error('Errore archiviazione manuale:', err);
                    alert(`Impossibile archiviare la cronologia: ${err.message}`);
                } finally {
                    clearActivitiesBtn.disabled = false;
                    clearActivitiesBtn.innerHTML = '<i class="fa-solid fa-box-archive"></i> Archivia Tutto';
                }
            }
        });
    }

    if (activityPrevBtn) {
        activityPrevBtn.addEventListener('click', () => {
            if (currentActivityPage > 1) {
                fetchAndDisplayActivities(currentActivityPage - 1);
            }
        });
    }

    if (activityNextBtn) {
        activityNextBtn.addEventListener('click', () => {
            fetchAndDisplayActivities(currentActivityPage + 1);
        });
    }

    // --- Gestione Modalità Debug / Produzione ---
    async function checkAppMode() {
        try {
            const response = await fetch('/api/settings/mode');
            if (response.ok) {
                const data = await response.json();
                updateAppModeUI(data.mode);
            }
        } catch (e) {
            console.error('Errore nel recupero della modalità applicazione:', e);
        }
    }

    function updateAppModeUI(mode) {
        const debugBanner = document.getElementById('debug-mode-banner');
        const debugBadge = document.getElementById('debug-badge');
        const modeText = document.getElementById('app-mode-text');
        const toggleBtn = document.getElementById('toggle-app-mode-btn');

        if (mode === 'debug') {
            if (debugBanner) debugBanner.classList.remove('d-none');
            if (debugBadge) {
                debugBadge.classList.remove('d-none');
                debugBadge.classList.add('d-inline-block');
            }
            if (modeText) modeText.innerHTML = `Modalità corrente: <strong class="text-danger">Debug</strong>`;
            if (toggleBtn) {
                toggleBtn.textContent = 'Passa a Produzione';
                toggleBtn.classList.remove('btn-outline-warning');
                toggleBtn.classList.add('btn-outline-success');
            }
        } else {
            if (debugBanner) debugBanner.classList.add('d-none');
            if (debugBadge) {
                debugBadge.classList.add('d-none');
                debugBadge.classList.remove('d-inline-block');
            }
            if (modeText) modeText.innerHTML = `Modalità corrente: <strong class="text-success">Produzione</strong>`;
            if (toggleBtn) {
                toggleBtn.textContent = 'Passa a Debug';
                toggleBtn.classList.remove('btn-outline-success');
                toggleBtn.classList.add('btn-outline-warning');
            }
        }
    }

    async function toggleAppMode(targetMode) {
        if (targetMode === 'debug') {
            const confirmToggle = confirm(
                "Attenzione! Passando alla modalità di debug, tutte le email inviate da questo server NON saranno effettivamente spedite ai destinatari, ma verranno solamente registrate nel file di log. Sicuro di voler attivare la modalità di debug?"
            );
            if (!confirmToggle) return;
        }

        try {
            const response = await fetch('/api/settings/mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: targetMode })
            });

            if (response.ok) {
                const data = await response.json();
                updateAppModeUI(data.mode);
                alert(`Applicazione impostata in modalità ${data.mode === 'debug' ? 'DEBUG' : 'PRODUZIONE'} con successo.`);
            } else {
                const errMsg = await response.text();
                alert(`Errore nel cambio modalità: ${errMsg}`);
            }
        } catch (e) {
            console.error('Errore durante il cambio modalità:', e);
            alert(`Errore di connessione o del server nel cambio modalità.`);
        }
    }

    const toggleAppModeBtn = document.getElementById('toggle-app-mode-btn');
    if (toggleAppModeBtn) {
        toggleAppModeBtn.addEventListener('click', () => {
            const isCurrentlyDebug = toggleAppModeBtn.classList.contains('btn-outline-success');
            const targetMode = isCurrentlyDebug ? 'production' : 'debug';
            toggleAppMode(targetMode);
        });
    }

    const disableDebugBannerBtn = document.getElementById('disable-debug-banner-btn');
    if (disableDebugBannerBtn) {
        disableDebugBannerBtn.addEventListener('click', () => {
            toggleAppMode('production');
        });
    }

    // --- Redmine Legend Modal Logic ---
    const legendModal = document.getElementById('redmine-legend-modal');
    const redmineHelpBtn = document.getElementById('redmine-help-btn');
    const closeLegendBtn = document.getElementById('close-legend-modal');
    const confirmLegendBtn = document.getElementById('confirm-legend-modal');

    if (redmineHelpBtn && legendModal) {
        redmineHelpBtn.addEventListener('click', () => {
            legendModal.style.display = 'flex';
        });
    }

    const closeLegendModal = () => {
        if (legendModal) legendModal.style.display = 'none';
    };

    if (closeLegendBtn) closeLegendBtn.addEventListener('click', closeLegendModal);
    if (confirmLegendBtn) confirmLegendBtn.addEventListener('click', closeLegendModal);

    // --- Redmine Fullscreen Heatmap Modal Logic ---
    const heatmapModal = document.getElementById('heatmap-fullscreen-modal');
    const btnFullscreenHeatmap = document.getElementById('btn-fullscreen-heatmap');
    const closeHeatmapBtn = document.getElementById('close-heatmap-modal');
    const confirmHeatmapBtn = document.getElementById('confirm-heatmap-modal');

    if (btnFullscreenHeatmap && heatmapModal) {
        btnFullscreenHeatmap.addEventListener('click', () => {
            openHeatmapFullscreen();
        });
    }

    const closeHeatmapModal = () => {
        if (heatmapModal) heatmapModal.style.display = 'none';
    };

    if (closeHeatmapBtn) closeHeatmapBtn.addEventListener('click', closeHeatmapModal);
    if (confirmHeatmapBtn) confirmHeatmapBtn.addEventListener('click', closeHeatmapModal);

    function openHeatmapFullscreen(focusHour = null) {
        if (!heatmapModal) return;
        heatmapModal.style.display = 'flex';
        renderFullscreenHeatmapChart();
        if (focusHour !== null) {
            showTicketsForHour(focusHour);
        } else {
            const titleEl = document.getElementById('heatmap-selected-hour-title');
            if (titleEl) {
                titleEl.textContent = 'Seleziona una fascia oraria nel grafico per visualizzare i dettagli dei ticket';
            }
            const tbody = document.getElementById('heatmap-tickets-table-body');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-muted">Clicca su una barra del grafico sopra.</td></tr>`;
            }
        }
    }

    function calculateGaussianCurve(hourlyCounts) {
        let totalTickets = 0;
        let sumHours = 0;

        for (let hour = 0; hour < 24; hour++) {
            const count = hourlyCounts[hour];
            totalTickets += count;
            sumHours += count * hour;
        }

        if (totalTickets === 0) {
            return Array(24).fill(0);
        }

        const mu = sumHours / totalTickets;
        
        let sumSqDiff = 0;
        for (let hour = 0; hour < 24; hour++) {
            const count = hourlyCounts[hour];
            sumSqDiff += count * Math.pow(hour - mu, 2);
        }
        
        const variance = sumSqDiff / totalTickets;
        const sigma = Math.sqrt(variance) || 1; // avoid division by zero
        
        const gaussianData = [];
        for (let hour = 0; hour < 24; hour++) {
            const pdf = (1 / (sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-Math.pow(hour - mu, 2) / (2 * Math.pow(sigma, 2)));
            gaussianData.push(totalTickets * pdf);
        }
        return gaussianData;
    }

    function renderFullscreenHeatmapChart() {
        const heatmapCanvas = document.getElementById('fullscreen-heatmap-chart');
        if (!heatmapCanvas) return;
        
        if (fullscreenHeatmapChartInstance) {
            fullscreenHeatmapChartInstance.destroy();
        }
        
        const hourlyCounts = Array(24).fill(0);
        currentIssuesForHeatmap.forEach(i => {
            const date = new Date(i.created_on);
            const hour = date.getHours();
            hourlyCounts[hour]++;
        });
        
        const hourlyLabels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
        const isDarkMode = document.body.classList.contains('dark-mode');
        const textColor = isDarkMode ? '#9ca3af' : '#4b5563';
        const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
        
        const gaussianData = calculateGaussianCurve(hourlyCounts);
        
        const ctx = heatmapCanvas.getContext('2d');
        fullscreenHeatmapChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: hourlyLabels,
                datasets: [
                    {
                        type: 'line',
                        label: 'Curva Gaussiana',
                        data: gaussianData,
                        borderColor: '#ef4444',
                        borderWidth: 2.5,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        fill: false,
                        tension: 0.4
                    },
                    {
                        type: 'bar',
                        label: 'Ticket Aperti',
                        data: hourlyCounts,
                        backgroundColor: 'rgba(245, 158, 11, 0.7)',
                        borderColor: '#f59e0b',
                        borderWidth: 1,
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: textColor,
                            font: { family: 'Poppins', size: 10 }
                        }
                    },
                    y: {
                        grid: { color: gridColor },
                        ticks: {
                            color: textColor,
                            font: { family: 'Poppins', size: 10 },
                            precision: 0
                        },
                        beginAtZero: true
                    }
                },
                onClick: (event, elements) => {
                    if (elements && elements.length > 0) {
                        const index = elements[0].index;
                        showTicketsForHour(index);
                    }
                }
            }
        });
    }

    function showTicketsForHour(hour) {
        const titleEl = document.getElementById('heatmap-selected-hour-title');
        if (titleEl) {
            titleEl.textContent = `Ticket aperti nella fascia oraria ${String(hour).padStart(2, '0')}:00 - ${String(hour).padStart(2, '0')}:59`;
        }
        
        const tbody = document.getElementById('heatmap-tickets-table-body');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        
        const filtered = currentIssuesForHeatmap.filter(i => {
            const date = new Date(i.created_on);
            return date.getHours() === hour;
        });
        
        filtered.sort((a, b) => new Date(b.created_on) - new Date(a.created_on));
        
        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-muted">Nessun ticket aperto in questa fascia oraria.</td></tr>`;
            return;
        }
        
        filtered.forEach(issue => {
            const tr = document.createElement('tr');
            
            const projClass = issue.project.id === 7312 ? 'project-lvl2' : 'project-lvl1';
            const projName = issue.project.id === 7312 ? 'L2' : 'L1';
            const projBadge = `<span class="redmine-project-badge ${projClass}" title="${DOMPurify.sanitize(issue.project.name)}">${projName}</span>`;
            
            const isUrgent = issue.priority && (issue.priority.id === 3 || issue.priority.name.toLowerCase() === 'alta');
            const priorityText = issue.priority ? issue.priority.name : 'Normale';
            let priorityBadge = '';
            if (isUrgent) {
                priorityBadge = `<span class="redmine-priority-badge priority-alta">${DOMPurify.sanitize(priorityText)}</span>`;
            } else {
                priorityBadge = `<span class="text-secondary small">${DOMPurify.sanitize(priorityText)}</span>`;
            }
            
            const createdDate = new Date(issue.created_on);
            const formattedTime = createdDate.toLocaleString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
            
            tr.innerHTML = `
                <td class="small fw-semibold text-secondary">#${issue.id}</td>
                <td>${projBadge}</td>
                <td>
                    <a href="https://projects.maestrale.it/issues/${issue.id}" target="_blank" rel="noopener noreferrer" class="ticket-link">
                        ${DOMPurify.sanitize(issue.subject)}
                    </a>
                </td>
                <td>${priorityBadge}</td>
                <td class="small text-secondary">${formattedTime}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    // Esegui check all'avvio
    checkAppMode();

    // --- Sezione Analisi Nerd ---
    let volumeChartInstance = null;
    let categoryChartInstance = null;
    let sendersChartInstance = null;
    let hourlyChartInstance = null;
    let cachedEmailStatsData = null;
    let fullscreenChartInstance = null;

    async function loadEmailStats(forceRefresh = false) {
        console.log('loadEmailStats called, forceRefresh:', forceRefresh);
        const statsView = document.getElementById('stats-view');
        if (!statsView) {
            console.warn('stats-view element not found in DOM');
            return;
        }

        try {
            const tableBody = document.getElementById('stats-patterns-table-body');
            if (tableBody) {
                tableBody.innerHTML = `
                    <tr><td colspan="2" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin me-2"></i>Caricamento statistiche...</td></tr>
                `;
            }

            const periodSelect = document.getElementById('stats-period-select');
            const period = periodSelect ? periodSelect.value : 'week';
            console.log(`Fetching /api/email-stats?period=${period}...`);
            const response = await fetch(`/api/email-stats?period=${period}`);
            if (!response.ok) throw new Error('Impossibile caricare le statistiche (status ' + response.status + ')');
            const data = await response.json();
            cachedEmailStatsData = data;
            console.log('Stats fetched successfully:', data);

            // Aggiorna KPI
            const kpiTotal = document.getElementById('stats-kpi-total');
            const kpiHuman = document.getElementById('kpi-human');
            const kpiBot = document.getElementById('kpi-bot');
            const kpiCloud = document.getElementById('kpi-cloud');

            if (kpiTotal) kpiTotal.textContent = data.totalEmails;
            if (kpiHuman) kpiHuman.textContent = data.categoryStats.human;
            if (kpiBot) kpiBot.textContent = data.categoryStats.bot;
            if (kpiCloud) kpiCloud.textContent = data.categoryStats.cloudMonitor;

            // Renderizza Grafici
            renderVolumeChart(data.dateStats);
            renderCategoryChart(data.categoryStats);
            renderSendersChart(data.topSenders);
            renderHourlyChart(data.hourlyStats);

            // Renderizza Tabella Pattern
            renderPatternsTable(data.topPatterns);

        } catch (error) {
            console.error('Errore nel caricamento delle statistiche:', error);
            const tableBody = document.getElementById('stats-patterns-table-body');
            if (tableBody) {
                tableBody.innerHTML = `
                    <tr><td colspan="2" class="text-center text-danger"><i class="fa-solid fa-triangle-exclamation me-2"></i>Errore: ${error.message}</td></tr>
                `;
            }
        }
    }

    window.loadEmailStats = loadEmailStats; // Make it globally accessible if needed

    function renderVolumeChart(dateStats) {
        const canvas = document.getElementById('stats-volume-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (volumeChartInstance) volumeChartInstance.destroy();

        const titleEl = document.getElementById('stats-volume-title');
        if (titleEl) {
            const periodLabels = {
                'day': 'Volume Storico (Oggi)',
                'week': 'Volume Storico (Ultimi 7 Giorni)',
                'month': 'Volume Storico (Ultimi 30 Giorni)',
                'year': 'Volume Storico (Ultimi 12 Mesi)',
                'all': 'Volume Storico (Tutto il Periodo)'
            };
            const period = document.getElementById('stats-period-select')?.value || 'week';
            titleEl.innerHTML = `<i class="fa-solid fa-chart-line me-2"></i>${periodLabels[period] || 'Volume Storico'}`;
        }

        const labels = dateStats.map(d => {
            const parts = d.date.split('-');
            if (parts.length === 3) {
                return `${parts[2]}/${parts[1]}`;
            } else if (parts.length === 2) {
                return `${parts[1]}/${parts[0]}`;
            }
            return d.date;
        });
        const values = dateStats.map(d => d.count);

        volumeChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Email Ricevute',
                    data: values,
                    borderColor: '#4A90E2',
                    backgroundColor: 'rgba(74, 144, 226, 0.1)',
                    fill: true,
                    tension: 0.3,
                    borderWidth: 2,
                    pointBackgroundColor: '#4A90E2'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onClick: (event, elements) => {
                    if (elements && elements.length > 0) {
                        const index = elements[0].index;
                        handleChartClick('volume', index);
                    }
                },
                onHover: (event, chartElement) => {
                    event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
                },
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: getGridColor() },
                        ticks: { color: getTextColor(), stepSize: 1 }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: getTextColor() }
                    }
                }
            }
        });
    }

    function renderCategoryChart(catStats) {
        const canvas = document.getElementById('stats-category-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (categoryChartInstance) categoryChartInstance.destroy();

        categoryChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Umane', 'Bot', 'Cloud Monitor'],
                datasets: [{
                    data: [catStats.human, catStats.bot, catStats.cloudMonitor],
                    backgroundColor: ['#28a745', '#dc3545', '#ffc107'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onClick: (event, elements) => {
                    if (elements && elements.length > 0) {
                        const index = elements[0].index;
                        handleChartClick('category', index);
                    }
                },
                onHover: (event, chartElement) => {
                    event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: getTextColor(), boxWidth: 12, font: { size: 11 } }
                    }
                },
                cutout: '70%'
            }
        });
    }

    function renderSendersChart(topSenders) {
        const canvas = document.getElementById('stats-senders-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (sendersChartInstance) sendersChartInstance.destroy();

        const senders = topSenders.slice(0, 10);
        const labels = senders.map(s => {
            const clean = s.name.replace(/<.*>/, '').trim();
            return clean.length > 25 ? clean.substring(0, 22) + '...' : clean;
        });
        const values = senders.map(s => s.count);

        sendersChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Email',
                    data: values,
                    backgroundColor: 'rgba(74, 144, 226, 0.75)',
                    hoverBackgroundColor: '#4A90E2',
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                onClick: (event, elements) => {
                    if (elements && elements.length > 0) {
                        const index = elements[0].index;
                        handleChartClick('senders', index);
                    }
                },
                onHover: (event, chartElement) => {
                    event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
                },
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        grid: { color: getGridColor() },
                        ticks: { color: getTextColor() }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { color: getTextColor(), font: { size: 10 } }
                    }
                }
            }
        });
    }

    function renderHourlyChart(hourlyStats) {
        const canvas = document.getElementById('stats-hourly-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (hourlyChartInstance) hourlyChartInstance.destroy();

        const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);

        hourlyChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Email Ricevute',
                    data: hourlyStats,
                    backgroundColor: 'rgba(245, 166, 35, 0.7)',
                    hoverBackgroundColor: '#F5A623',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onClick: (event, elements) => {
                    if (elements && elements.length > 0) {
                        const index = elements[0].index;
                        handleChartClick('hourly', index);
                    }
                },
                onHover: (event, chartElement) => {
                    event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
                },
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: getGridColor() },
                        ticks: { color: getTextColor() }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: getTextColor(), font: { size: 9 } }
                    }
                }
            }
        });
    }

    function renderPatternsTable(topPatterns) {
        const tbody = document.getElementById('stats-patterns-table-body');
        if (!tbody) return;
        if (!topPatterns || topPatterns.length === 0) {
            tbody.innerHTML = `<tr><td colspan="2" class="text-center text-muted">Nessun pattern rilevato</td></tr>`;
            return;
        }

        let html = '';
        topPatterns.forEach(p => {
            const safePattern = p.name
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

            html += `
                <tr>
                    <td class="fw-bold"><span class="badge bg-secondary px-2 py-1">${p.count}</span></td>
                    <td class="font-monospace small text-wrap">${safePattern}</td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    }

    function getTextColor() {
        return document.body.classList.contains('dark-mode') ? '#EAEAEA' : '#4A4A4A';
    }

    // --- Gestione Grafici Interattivi e Fullscreen ---
    
    // Assegna listener ai pulsanti di fullscreen
    document.querySelectorAll('.btn-fullscreen-chart').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const chartType = btn.getAttribute('data-chart');
            openFullscreenChart(chartType);
        });
    });

    // Close fullscreen chart modal
    const closeFullscreenBtn = document.getElementById('close-fullscreen-chart');
    if (closeFullscreenBtn) {
        closeFullscreenBtn.addEventListener('click', () => {
            const modal = document.getElementById('chart-fullscreen-modal');
            if (modal) modal.style.display = 'none';
            if (fullscreenChartInstance) {
                fullscreenChartInstance.destroy();
                fullscreenChartInstance = null;
            }
        });
    }

    // Close details list modal
    const closeDetailsBtn = document.getElementById('close-chart-details');
    if (closeDetailsBtn) {
        closeDetailsBtn.addEventListener('click', () => {
            const modal = document.getElementById('chart-details-modal');
            if (modal) modal.style.display = 'none';
        });
    }

    // Chiudi modali al click esterno sulla sovrapposizione
    document.querySelectorAll('#chart-fullscreen-modal, #chart-details-modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
                if (modal.id === 'chart-fullscreen-modal' && fullscreenChartInstance) {
                    fullscreenChartInstance.destroy();
                    fullscreenChartInstance = null;
                }
            }
        });
    });

    async function handleChartClick(chartType, index) {
        if (!cachedEmailStatsData) return;

        let queryParams = {};
        let title = '';

        if (chartType === 'volume') {
            const item = cachedEmailStatsData.dateStats[index];
            if (!item) return;
            const periodSelect = document.getElementById('stats-period-select');
            const period = periodSelect ? periodSelect.value : 'week';
            if (period === 'day') {
                const CEST_OFFSET = 2 * 60 * 60 * 1000;
                const dt = new Date(Date.now() + CEST_OFFSET);
                queryParams.date = dt.toISOString().split('T')[0];
                queryParams.hour = parseInt(item.date.split(':')[0], 10);
                title = `Email di oggi alle ore ${item.date}`;
            } else {
                queryParams.date = item.date;
                title = `Email del ${formatDateString(item.date)}`;
            }
        } else if (chartType === 'category') {
            const categories = ['human', 'bot', 'cloudMonitor'];
            const categoryLabels = ['Umane', 'Bot / Automatiche', 'Cloud Monitor'];
            const cat = categories[index];
            if (!cat) return;
            queryParams.category = cat;
            title = `Email Categoria: ${categoryLabels[index]}`;
        } else if (chartType === 'senders') {
            const item = cachedEmailStatsData.topSenders[index];
            if (!item) return;
            queryParams.sender = item.name;
            const cleanSender = item.name.replace(/<.*>/, '').trim();
            title = `Email da: ${cleanSender}`;
        } else if (chartType === 'hourly') {
            queryParams.hour = index;
            title = `Email ricevute alle ore ${index}:00 - ${index}:59`;
        }

        openChartDetailsModal(title, queryParams);
    }

    async function openChartDetailsModal(title, queryParams) {
        const modal = document.getElementById('chart-details-modal');
        const titleEl = document.getElementById('chart-details-title');
        const listEl = document.getElementById('chart-details-list');
        const loadingEl = document.getElementById('chart-details-loading');
        const emptyEl = document.getElementById('chart-details-empty');

        if (!modal) return;

        modal.style.display = 'flex';
        titleEl.textContent = title;
        listEl.innerHTML = '';
        loadingEl.style.display = 'block';
        emptyEl.style.display = 'none';

        try {
            const queryString = new URLSearchParams(queryParams).toString();
            const response = await fetch(`/api/email-stats/query?${queryString}`, {
                headers: { 'Accept': 'application/json' }
            });
            if (!response.ok) throw new Error('Status ' + response.status);
            const data = await response.json();

            loadingEl.style.display = 'none';

            if (!data.emails || data.emails.length === 0) {
                emptyEl.style.display = 'block';
                return;
            }

            data.emails.forEach(email => {
                const item = document.createElement('div');
                item.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-3 p-3 border-0 border-bottom bg-transparent';
                item.style.cursor = 'pointer';

                const formattedDate = formatTimestamp(email.internalDate);
                
                let badgeClass = 'bg-secondary';
                let badgeLabel = 'Sconosciuto';
                if (email.category === 'human') {
                    badgeClass = 'bg-success-subtle text-success border border-success-subtle';
                    badgeLabel = 'Umana';
                } else if (email.category === 'bot') {
                    badgeClass = 'bg-danger-subtle text-danger border border-danger-subtle';
                    badgeLabel = 'Bot';
                } else if (email.category === 'cloudMonitor') {
                    badgeClass = 'bg-warning-subtle text-warning border border-warning-subtle';
                    badgeLabel = 'Cloud Monitor';
                }

                item.innerHTML = `
                    <div class="flex-grow-1 min-w-0" style="text-align: left;">
                        <div class="d-flex justify-content-between align-items-baseline mb-1">
                            <span class="fw-bold text-truncate text-primary" style="max-width: 300px; display: inline-block;">${escapeHtml(email.from)}</span>
                            <span class="text-muted small">${formattedDate}</span>
                        </div>
                        <div class="text-truncate fw-semibold text-body-emphasis mb-1" style="font-size: 0.95rem;">${escapeHtml(email.subject)}</div>
                        <div class="text-muted small text-truncate" style="opacity: 0.85;">${escapeHtml(email.snippet)}</div>
                    </div>
                    <span class="badge ${badgeClass} px-2 py-1">${badgeLabel}</span>
                `;

                item.addEventListener('click', () => {
                    modal.style.display = 'none';
                    openFullScreenEmail(email);
                });

                listEl.appendChild(item);
            });

        } catch (err) {
            console.error('Errore nel recupero della query delle email:', err);
            loadingEl.style.display = 'none';
            listEl.innerHTML = `<div class="text-center text-danger py-4"><i class="fa-solid fa-circle-exclamation me-2"></i>Errore nel caricamento: ${err.message}</div>`;
        }
    }

    function openFullscreenChart(chartType) {
        if (!cachedEmailStatsData) return;

        const modal = document.getElementById('chart-fullscreen-modal');
        const canvas = document.getElementById('fullscreen-chart-canvas');
        const titleEl = document.getElementById('fullscreen-chart-title');

        if (!modal || !canvas) return;

        modal.style.display = 'flex';

        if (fullscreenChartInstance) fullscreenChartInstance.destroy();
        const ctx = canvas.getContext('2d');

        let type = 'line';
        let data = {};
        let options = {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (event, elements) => {
                if (elements && elements.length > 0) {
                    const index = elements[0].index;
                    modal.style.display = 'none';
                    if (fullscreenChartInstance) {
                        fullscreenChartInstance.destroy();
                        fullscreenChartInstance = null;
                    }
                    handleChartClick(chartType, index);
                }
            },
            onHover: (event, chartElement) => {
                event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
            }
        };

        if (chartType === 'volume') {
            const periodSelect = document.getElementById('stats-period-select');
            const period = periodSelect ? periodSelect.value : 'week';
            const periodLabels = {
                'day': 'Volume Storico (Oggi)',
                'week': 'Volume Storico (Ultimi 7 Giorni)',
                'month': 'Volume Storico (Ultimi 30 Giorni)',
                'year': 'Volume Storico (Ultimi 12 Mesi)',
                'all': 'Volume Storico (Tutto il Periodo)'
            };
            titleEl.innerHTML = `<i class="fa-solid fa-chart-line text-warning me-2"></i> ${periodLabels[period] || 'Volume Storico'}`;
            type = 'line';
            const labels = cachedEmailStatsData.dateStats.map(d => {
                const parts = d.date.split('-');
                if (parts.length === 3) {
                    return `${parts[2]}/${parts[1]}`;
                } else if (parts.length === 2) {
                    return `${parts[1]}/${parts[0]}`;
                }
                return d.date;
            });
            const values = cachedEmailStatsData.dateStats.map(d => d.count);
            data = {
                labels,
                datasets: [{
                    label: 'Email Ricevute',
                    data: values,
                    borderColor: '#4A90E2',
                    backgroundColor: 'rgba(74, 144, 226, 0.15)',
                    fill: true,
                    tension: 0.3,
                    borderWidth: 3,
                    pointBackgroundColor: '#4A90E2',
                    pointRadius: 6,
                    pointHoverRadius: 8
                }]
            };
            options.scales = {
                y: {
                    beginAtZero: true,
                    grid: { color: getGridColor() },
                    ticks: { color: getTextColor(), font: { size: 12 }, stepSize: 1 }
                },
                x: {
                    grid: { color: getGridColor() },
                    ticks: { color: getTextColor(), font: { size: 12 } }
                }
            };
            options.plugins = {
                legend: { display: false }
            };
        } else if (chartType === 'category') {
            titleEl.innerHTML = '<i class="fa-solid fa-chart-pie text-warning me-2"></i> Composizione Inbox';
            type = 'doughnut';
            data = {
                labels: ['Umane', 'Bot', 'Cloud Monitor'],
                datasets: [{
                    data: [
                        cachedEmailStatsData.categoryStats.human,
                        cachedEmailStatsData.categoryStats.bot,
                        cachedEmailStatsData.categoryStats.cloudMonitor
                    ],
                    backgroundColor: ['#28a745', '#dc3545', '#ffc107'],
                    borderWidth: 0
                }]
            };
            options.plugins = {
                legend: {
                    position: 'bottom',
                    labels: { color: getTextColor(), boxWidth: 16, font: { size: 14 }, padding: 20 }
                }
            };
            options.cutout = '65%';
        } else if (chartType === 'senders') {
            titleEl.innerHTML = '<i class="fa-solid fa-users text-warning me-2"></i> Top 10 Mittenti';
            type = 'bar';
            options.indexAxis = 'y';
            const senders = cachedEmailStatsData.topSenders.slice(0, 10);
            const labels = senders.map(s => s.name.replace(/<.*>/, '').trim());
            const values = senders.map(s => s.count);
            data = {
                labels,
                datasets: [{
                    label: 'Email',
                    data: values,
                    backgroundColor: 'rgba(74, 144, 226, 0.8)',
                    hoverBackgroundColor: '#4A90E2',
                    borderRadius: 4
                }]
            };
            options.scales = {
                x: {
                    beginAtZero: true,
                    grid: { color: getGridColor() },
                    ticks: { color: getTextColor(), font: { size: 12 } }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: getTextColor(), font: { size: 12 } }
                }
            };
            options.plugins = {
                legend: { display: false }
            };
        } else if (chartType === 'hourly') {
            titleEl.innerHTML = '<i class="fa-solid fa-clock text-warning me-2"></i> Distribuzione Oraria (Fasce CEST)';
            type = 'bar';
            const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
            data = {
                labels,
                datasets: [{
                    label: 'Email Ricevute',
                    data: cachedEmailStatsData.hourlyStats,
                    backgroundColor: 'rgba(245, 166, 35, 0.85)',
                    hoverBackgroundColor: '#F5A623',
                    borderRadius: 4
                }]
            };
            options.scales = {
                y: {
                    beginAtZero: true,
                    grid: { color: getGridColor() },
                    ticks: { color: getTextColor(), font: { size: 12 } }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: getTextColor(), font: { size: 11 } }
                }
            };
            options.plugins = {
                legend: { display: false }
            };
        }

        fullscreenChartInstance = new Chart(ctx, {
            type,
            data,
            options
        });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#39;');
    }

    function formatTimestamp(ts) {
        if (!ts) return '';
        const date = new Date(parseInt(ts, 10));
        return date.toLocaleString('it-IT');
    }

    function formatDateString(dateStr) {
        if (!dateStr) return '';
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            return `${parts[2]}/${parts[1]}/${parts[0]}`;
        }
        if (parts.length === 2) {
            return `${parts[1]}/${parts[0]}`;
        }
        return dateStr;
    }

    function getGridColor() {
        return document.body.classList.contains('dark-mode') ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
    }

    // --- Server Restart Logic ---
    let serverRestartInterval = null;
    let localCountdownInterval = null;
    let isServerOfflineReconnecting = false;
    let isRestartOverlayDismissed = false; // Flag to allow dismissing the alert once read

    // Aggiunge l'event listener per il bottone di restart
    const restartBtn = document.getElementById('restart-server-btn');
    const restartSelect = document.getElementById('restart-countdown-select');
    if (restartBtn) {
        restartBtn.addEventListener('click', async () => {
            const countdownVal = restartSelect ? parseInt(restartSelect.value, 10) : 30;
            const confirmMsg = `Sei sicuro di voler avviare il countdown di ${countdownVal} secondi per il riavvio del server?\n\nTutti gli utenti connessi visualizzeranno un avviso di disconnessione.`;
            if (!confirm(confirmMsg)) return;

            try {
                const res = await fetch('/api/server/restart', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ countdown: countdownVal })
                });

                if (res.ok) {
                    showToast("Riavvio programmato con successo!", "success");
                    // Chiude il modal account
                    const accountModal = document.getElementById('account-modal');
                    if (accountModal) accountModal.style.display = 'none';
                } else {
                    const errorMsg = await res.text();
                    showToast(`Errore durante l'avvio del riavvio: ${errorMsg}`, "error");
                }
            } catch (err) {
                console.error("Errore richiamando restart:", err);
                showToast("Errore di rete durante la richiesta di riavvio.", "error");
            }
        });
    }

    // Aggiunge l'event listener per nascondere l'avviso (dismiss button)
    const dismissOverlayBtn = document.getElementById('dismiss-restart-btn');
    if (dismissOverlayBtn) {
        dismissOverlayBtn.addEventListener('click', () => {
            isRestartOverlayDismissed = true;
            const overlay = document.getElementById('server-restart-overlay');
            if (overlay) overlay.style.display = 'none';
        });
    }

    // Controlla lo stato del riavvio ogni 3 secondi
    function startServerRestartPolling() {
        serverRestartInterval = setInterval(async () => {
            if (isServerOfflineReconnecting) {
                checkServerReconnection();
                return;
            }

            try {
                const res = await fetch('/api/server/restart-status');
                if (res.ok) {
                    const data = await res.json();
                    if (data.isRestarting) {
                        updateRestartOverlay(data.countdownRemaining, data.countdownMax, data.requestedBy);
                    } else {
                        hideRestartOverlay();
                    }
                } else if (res.status === 401) {
                    // Sessione non valida o scaduta, ma ignoriamo se c'è un restart in corso
                }
            } catch (err) {
                // Se la chiamata fallisce ma eravamo in countdown (o si interrompe la connessione),
                // consideriamo il server in fase di reboot.
                if (localCountdownInterval) {
                    transitionToOfflineReconnection();
                }
            }
        }, 3000);
    }

    function updateRestartOverlay(remaining, max, requester) {
        const overlay = document.getElementById('server-restart-overlay');
        const requesterSpan = document.getElementById('restart-requester');

        if (!overlay) return;

        // Se l'utente ha già nascosto l'avviso, non forzare la comparsa dell'overlay,
        // ma assicuriamoci comunque che il countdown locale stia girando in background per la transizione finale.
        if (isRestartOverlayDismissed) {
            if (!localCountdownInterval) {
                startLocalCountdown(remaining, max);
            }
            if (requesterSpan) requesterSpan.textContent = requester || 'Sistema';
            return;
        }

        // Visualizza l'overlay
        if (overlay.style.display === 'none') {
            overlay.style.display = 'flex';
            
            // Assicura che il pulsante dismiss sia visibile nella fase di countdown
            const dismissBtn = document.getElementById('dismiss-restart-btn');
            if (dismissBtn) dismissBtn.style.display = 'block';

            // Avvia un timer locale al secondo per decrementare fluidamente il contatore tra un poll e l'altro
            startLocalCountdown(remaining, max);
        }

        if (requesterSpan) requesterSpan.textContent = requester || 'Sistema';
    }

    function startLocalCountdown(initialRemaining, max) {
        if (localCountdownInterval) clearInterval(localCountdownInterval);

        let currentRemaining = initialRemaining;
        const updateUI = () => {
            const textVal = document.getElementById('countdown-text');
            const progressPath = document.getElementById('countdown-progress');
            
            if (textVal) textVal.textContent = currentRemaining;
            
            if (progressPath && max > 0) {
                const offset = 220 - (currentRemaining / max) * 220;
                progressPath.style.strokeDashoffset = offset;
                
                // Cambia colore in rosso se mancano meno di 5 secondi
                if (currentRemaining <= 5) {
                    progressPath.style.stroke = '#ef4444'; // Red
                } else {
                    progressPath.style.stroke = '#f59e0b'; // Amber
                }
            }

            if (currentRemaining <= 0) {
                clearInterval(localCountdownInterval);
                localCountdownInterval = null;
                transitionToOfflineReconnection();
            }
        };

        updateUI();

        localCountdownInterval = setInterval(() => {
            currentRemaining--;
            if (currentRemaining < 0) currentRemaining = 0;
            updateUI();
        }, 1000);
    }

    function transitionToOfflineReconnection() {
        if (localCountdownInterval) {
            clearInterval(localCountdownInterval);
            localCountdownInterval = null;
        }

        isServerOfflineReconnecting = true;
        isRestartOverlayDismissed = false; // Resettiamo per forzare la visualizzazione dell'overlay offline

        const overlay = document.getElementById('server-restart-overlay');
        if (overlay) {
            overlay.style.display = 'flex'; // Forza la visualizzazione
            overlay.classList.add('offline');
            
            // Nasconde il pulsante per chiudere l'alert durante il downtime del server
            const dismissBtn = document.getElementById('dismiss-restart-btn');
            if (dismissBtn) dismissBtn.style.display = 'none';

            const title = document.getElementById('restart-title');
            const desc = document.getElementById('restart-description');
            const subtext = document.getElementById('restart-status-subtext');
            
            if (title) title.textContent = "Riavvio in Corso...";
            if (desc) desc.innerHTML = `<i class="fa-solid fa-spinner fa-spin me-2 text-warning"></i> Il server si sta riavviando.<br>Attendi il ripristino del servizio...`;
            if (subtext) subtext.textContent = "Riconnessione automatica in corso...";
        }
    }

    function hideRestartOverlay() {
        const overlay = document.getElementById('server-restart-overlay');
        if (overlay) {
            overlay.style.display = 'none';
            overlay.classList.remove('offline');
        }
        if (localCountdownInterval) {
            clearInterval(localCountdownInterval);
            localCountdownInterval = null;
        }
        isServerOfflineReconnecting = false;
        isRestartOverlayDismissed = false; // Reset per i riavvii successivi
    }

    async function checkServerReconnection() {
        try {
            // Proviamo a chiamare l'endpoint di health check o versione (pubblico)
            const res = await fetch('/api/version');
            if (res.ok) {
                // Il server è tornato online!
                const title = document.getElementById('restart-title');
                const desc = document.getElementById('restart-description');
                const subtext = document.getElementById('restart-status-subtext');
                const iconWrapper = document.querySelector('.restart-overlay .restart-icon-wrapper');
                const icon = document.querySelector('.restart-overlay .warning-icon');

                if (title) title.textContent = "Server Online!";
                if (desc) desc.textContent = "Connessione stabilita con successo. Ricaricamento dell'applicazione...";
                if (subtext) subtext.textContent = "Ricaricamento della pagina...";
                if (iconWrapper) {
                    iconWrapper.style.background = 'rgba(34, 197, 94, 0.15)'; // Green opacity
                }
                if (icon) {
                    icon.className = "fa-solid fa-circle-check text-success warning-icon";
                }

                clearInterval(serverRestartInterval);

                setTimeout(() => {
                    window.location.reload();
                }, 1500);
            }
        } catch (err) {
            // Server ancora offline
            console.log("Server ancora non raggiungibile, riprovo...");
        }
    }

    // Avvia il monitoraggio
    startServerRestartPolling();

});
