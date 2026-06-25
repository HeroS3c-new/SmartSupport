/**
 * SmartSupport - Backup Hub Interface Logic
 * Handles real-time liveness statistics, CRUD configurations, Auto-Discovery scanning, 
 * run history logs, and premium UI animations.
 */

document.addEventListener('DOMContentLoaded', () => {
    // -------------------------------------------------------------
    // State Variables
    // -------------------------------------------------------------
    let backupSources = [];
    let autoDiscoverySuggestions = [];
    let currentFilter = 'all';
    let searchQuery = '';
    let discoverSearchQuery = '';
    let discoverSortField = null;
    let discoverSortDirection = 'asc';
    let currentTheme = 'dark';
    
    // Bootstrap Modal & Offcanvas Instances
    const sourceModalEl = document.getElementById('sourceModal');
    const sourceModal = new bootstrap.Modal(sourceModalEl);
    const runsOffcanvasEl = document.getElementById('runsOffcanvas');
    const runsOffcanvas = new bootstrap.Offcanvas(runsOffcanvasEl);
    const emailDetailModalEl = document.getElementById('emailDetailModal');
    const emailDetailModal = new bootstrap.Modal(emailDetailModalEl);
    const toastEl = document.getElementById('app-toast');
    const appToast = new bootstrap.Toast(toastEl, { delay: 4000 });
    
    // Elements
    const body = document.body;
    const themeSwitch = document.getElementById('theme-switch');
    const sourcesTableBody = document.getElementById('sources-table-body');
    const discoverTableBody = document.getElementById('discover-table-body');
    const searchInput = document.getElementById('source-search-input');
    const filterButtons = document.querySelectorAll('.btn-filter');
    const sourceForm = document.getElementById('source-form');
    const discoveryBadge = document.getElementById('discovery-badge');
    const discoverTab = document.getElementById('discover-tab');
    const trashBadge = document.getElementById('trash-badge');
    const trashTab = document.getElementById('trash-tab');
    const trashTableBody = document.getElementById('trash-table-body');
    
    // KPI Counters
    const kpiTotal = document.getElementById('kpi-total');
    const kpiOk = document.getElementById('kpi-ok');
    const kpiWarning = document.getElementById('kpi-warning');
    const kpiMissing = document.getElementById('kpi-missing');
    const kpiFailed = document.getElementById('kpi-failed');

    // -------------------------------------------------------------
    // Initialization & Theme Setup
    // -------------------------------------------------------------
    const savedTheme = localStorage.getItem('theme') || 'dark';
    currentTheme = savedTheme;
    if (currentTheme === 'dark') {
        body.classList.add('dark-mode');
    } else {
        body.classList.remove('dark-mode');
    }

    themeSwitch.addEventListener('click', () => {
        if (body.classList.contains('dark-mode')) {
            body.classList.remove('dark-mode');
            localStorage.setItem('theme', 'light');
            currentTheme = 'light';
        } else {
            body.classList.add('dark-mode');
            localStorage.setItem('theme', 'dark');
            currentTheme = 'dark';
        }
    });

    // Start Fetching Data
    fetchBackupSources();
    fetchAutoDiscovery();
    fetchExcludedEmails();

    // Set interval for live updates (refresh every 60 seconds)
    setInterval(() => {
        fetchBackupSources();
    }, 60000);

    // -------------------------------------------------------------
    // Event Listeners
    // -------------------------------------------------------------
    // Search listener
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase().trim();
        renderSourcesTable();
    });

    // Filter badges listener
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderSourcesTable();
        });
    });

    // Auto-Discovery scan on tab click
    discoverTab.addEventListener('click', () => {
        fetchAutoDiscovery();
    });

    // Trash tab click
    const trashTabEl = document.getElementById('trash-tab');
    if (trashTabEl) {
        trashTabEl.addEventListener('click', () => {
            fetchExcludedEmails();
        });
    }

    // Auto-Discovery Search listener
    const discoverSearchInput = document.getElementById('discover-search-input');
    if (discoverSearchInput) {
        discoverSearchInput.addEventListener('input', (e) => {
            discoverSearchQuery = e.target.value.toLowerCase().trim();
            renderDiscoveryTable(autoDiscoverySuggestions);
        });
    }

    // Auto-Discovery Headers Sorting listener
    const discoverHeaderRow = document.getElementById('discover-table-header-row');
    if (discoverHeaderRow) {
        discoverHeaderRow.querySelectorAll('th.sortable-th').forEach(th => {
            th.addEventListener('click', () => {
                const sortField = th.dataset.sort;
                if (discoverSortField === sortField) {
                    discoverSortDirection = (discoverSortDirection === 'asc') ? 'desc' : 'asc';
                } else {
                    discoverSortField = sortField;
                    discoverSortDirection = 'asc';
                }
                updateDiscoverHeaderIcons();
                renderDiscoveryTable(autoDiscoverySuggestions);
            });
        });
    }

    // Modal submit handler (Add or Update)
    sourceForm.addEventListener('submit', (e) => {
        e.preventDefault();
        saveSourceForm();
    });

    // Reset modal fields on manual "Nuova Sorgente" click
    document.getElementById('add-source-btn').addEventListener('click', () => {
        document.getElementById('sourceModalLabel').innerHTML = '<i class="fa-solid fa-plus text-warning me-2"></i>Aggiungi Sorgente Backup';
        document.getElementById('form-source-id').value = '';
        sourceForm.reset();
        document.getElementById('form-source-active').checked = true;
        hideRegexAssistant();
    });

    // -------------------------------------------------------------
    // Regex Assistant & Generator & Tester Logic
    // -------------------------------------------------------------
    const btnRegexGenerator = document.getElementById('btn-regex-generator');
    const regexAssistantPanel = document.getElementById('regex-assistant-panel');
    const btnCloseRegexAssistant = document.getElementById('btn-close-regex-assistant');
    const regexHelperEmailSelect = document.getElementById('regex-helper-email-select');
    const btnRefreshHelperEmails = document.getElementById('btn-refresh-helper-emails');
    const regexOptionsContainer = document.getElementById('regex-options-container');
    const regexOptionsList = document.getElementById('regex-options-list');
    const btnTestRegexRun = document.getElementById('btn-test-regex-run');
    const regexTestStatus = document.getElementById('regex-test-status');
    const regexTestResultsList = document.getElementById('regex-test-results-list');

    let loadedRecentEmails = [];
    let testRegexDebounceTimeout;

    function debounceTestRegex() {
        clearTimeout(testRegexDebounceTimeout);
        testRegexDebounceTimeout = setTimeout(() => {
            testCurrentRegex();
        }, 400);
    }

    // Helper to hide assistant panel
    function hideRegexAssistant() {
        if (regexAssistantPanel) {
            regexAssistantPanel.classList.add('d-none');
            regexHelperEmailSelect.value = '';
            regexOptionsContainer.classList.add('d-none');
            regexOptionsList.innerHTML = '';
        }
    }

    // Toggle assistant panel
    if (btnRegexGenerator) {
        btnRegexGenerator.addEventListener('click', () => {
            if (regexAssistantPanel.classList.contains('d-none')) {
                regexAssistantPanel.classList.remove('d-none');
                fetchRecentEmailsForHelper();
            } else {
                hideRegexAssistant();
            }
        });
    }

    if (btnCloseRegexAssistant) {
        btnCloseRegexAssistant.addEventListener('click', hideRegexAssistant);
    }

    // Fetch recent emails from current sender to populate helper select
    async function fetchRecentEmailsForHelper() {
        const sender = document.getElementById('form-source-sender').value.trim();
        regexHelperEmailSelect.innerHTML = '<option value="">-- Caricamento email recenti... --</option>';
        regexOptionsContainer.classList.add('d-none');

        try {
            const url = `/api/backup/recent-emails?sender=${encodeURIComponent(sender)}`;
            const res = await fetch(url);
            const data = await res.json();
            loadedRecentEmails = data.emails || [];

            regexHelperEmailSelect.innerHTML = '';
            if (loadedRecentEmails.length === 0) {
                regexHelperEmailSelect.innerHTML = '<option value="">-- Nessuna email recente trovata per questo mittente --</option>';
            } else {
                regexHelperEmailSelect.innerHTML = '<option value="">-- Seleziona un\'email recente da usare --</option>';
                loadedRecentEmails.forEach(email => {
                    const opt = document.createElement('option');
                    opt.value = email.id;
                    const dateStr = new Date(parseInt(email.internalDate)).toLocaleDateString('it-IT');
                    opt.textContent = `[${dateStr}] ${email.subject}`;
                    regexHelperEmailSelect.appendChild(opt);
                });
            }
        } catch (error) {
            console.error('Error fetching recent emails for helper:', error);
            regexHelperEmailSelect.innerHTML = '<option value="">-- Errore nel caricamento delle email --</option>';
        }
    }

    if (btnRefreshHelperEmails) {
        btnRefreshHelperEmails.addEventListener('click', fetchRecentEmailsForHelper);
    }

    // Automatically refresh emails list if sender is typed/changed
    const senderInput = document.getElementById('form-source-sender');
    if (senderInput) {
        senderInput.addEventListener('change', () => {
            if (regexAssistantPanel && !regexAssistantPanel.classList.contains('d-none')) {
                fetchRecentEmailsForHelper();
            }
        });
    }

    // Handle email selection to generate regex options
    if (regexHelperEmailSelect) {
        regexHelperEmailSelect.addEventListener('change', (e) => {
            const emailId = e.target.value;
            if (!emailId) {
                regexOptionsContainer.classList.add('d-none');
                return;
            }

            const selectedEmail = loadedRecentEmails.find(email => email.id === emailId);
            if (!selectedEmail) return;

            generateRegexOptions(selectedEmail.subject);
        });
    }

    // Escape regex utility
    function escapeRegExp(string) {
        return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    }

    // Main Regex Generator Logic
    function generateRegexOptions(subject) {
        regexOptionsList.innerHTML = '';
        
        // Option 1: Exact match anchored
        const escapedExact = '^' + escapeRegExp(subject) + '$';
        
        // Option 2: Dynamic capture inside brackets or parentheses
        let dynamicRegex = '';
        let inferredFingerprint = '';
        let hasBrackets = false;

        // Try square brackets first: e.g. "Backup [JOB-A1] Success"
        const squareBracketsMatch = subject.match(/\[([^\]]+)\]/);
        if (squareBracketsMatch) {
            const inner = squareBracketsMatch[0]; // [JOB-A1]
            inferredFingerprint = squareBracketsMatch[1]; // JOB-A1
            const escapedPart = escapeRegExp(subject.replace(inner, '###DYNAMIC###'));
            dynamicRegex = escapedPart.replace('###DYNAMIC###', '\\[(.*?)\\]');
            hasBrackets = true;
        } else {
            // Try parenthesis: e.g. "Backup (JOB-B2) Success"
            const parenMatch = subject.match(/\(([^)]+)\)/);
            if (parenMatch) {
                const inner = parenMatch[0];
                inferredFingerprint = parenMatch[1];
                const escapedPart = escapeRegExp(subject.replace(inner, '###DYNAMIC###'));
                dynamicRegex = escapedPart.replace('###DYNAMIC###', '\\((.*?)\\)');
                hasBrackets = true;
            }
        }

        // If no brackets but contains common backup patterns or numbers, infer general dynamic capture
        if (!hasBrackets) {
            const words = subject.split(/\s+/);
            if (words.length > 2) {
                const lastWord = words[words.length - 1];
                inferredFingerprint = lastWord;
                const escapedPart = escapeRegExp(subject.substring(0, subject.lastIndexOf(lastWord))) + '(.*?)';
                dynamicRegex = escapedPart;
            } else {
                dynamicRegex = escapeRegExp(subject);
                inferredFingerprint = subject;
            }
        }

        // Option 3: Loose "contains"
        let looseContains = '';
        const cleanSubject = subject.replace(/[^a-zA-Z0-9\s]/g, '');
        const words = cleanSubject.split(/\s+/).filter(w => w.length > 3);
        if (words.length >= 2) {
            looseContains = words.slice(0, 2).join('.*?');
        } else {
            looseContains = escapeRegExp(subject.substring(0, Math.floor(subject.length / 2)));
        }

        const options = [
            {
                title: 'Corrispondenza Esatta',
                desc: 'Cattura solo le email con questo identico oggetto.',
                regex: escapedExact,
                fingerprint: subject
            },
            {
                title: 'Cattura Dinamica (Fingerprint)',
                desc: 'Consigliata per flussi con codici o date dinamiche tra parentesi.',
                regex: dynamicRegex,
                fingerprint: inferredFingerprint
            },
            {
                title: 'Espressione Generica (Contiene)',
                desc: 'Verifica semplicemente se l\'oggetto contiene le parole chiave principali.',
                regex: looseContains,
                fingerprint: inferredFingerprint || 'Backup'
            }
        ];

        options.forEach(opt => {
            const card = document.createElement('div');
            card.className = 'p-2 rounded bg-dark border border-secondary d-flex justify-content-between align-items-center gap-2 mt-2';
            card.innerHTML = `
                <div style="flex: 1; min-width: 0;">
                    <div class="fw-semibold text-warning-emphasis fs-7">${opt.title}</div>
                    <code class="text-info fs-8 d-block text-truncate mt-1" style="user-select: all;" title="${opt.regex}">${opt.regex}</code>
                    <div class="text-muted fs-8 mt-1">${opt.desc}</div>
                </div>
                <div>
                    <button type="button" class="btn btn-xs btn-outline-warning text-nowrap py-1 apply-regex-btn">
                        <i class="fa-solid fa-check"></i> Applica
                    </button>
                </div>
            `;

            card.querySelector('.apply-regex-btn').addEventListener('click', () => {
                document.getElementById('form-source-subject-regex').value = opt.regex;
                showToast('Regex applicata con successo!', 'fa-wand-magic-sparkles', 'bg-success');
                testCurrentRegex();
            });

            regexOptionsList.appendChild(card);
        });

        regexOptionsContainer.classList.remove('d-none');
    }

    // Tester function
    async function testCurrentRegex() {
        const sender = document.getElementById('form-source-sender').value.trim();
        const subjectRegex = document.getElementById('form-source-subject-regex').value.trim();

        if (!subjectRegex) {
            regexTestStatus.innerHTML = '<span class="text-secondary">Digita la regex per vedere l\'anteprima.</span>';
            regexTestResultsList.style.display = 'none';
            return;
        }

        regexTestStatus.innerHTML = '<div class="spinner-border spinner-border-sm text-warning me-2" role="status"></div> Analisi della cache email in corso...';
        regexTestResultsList.style.display = 'none';
        regexTestResultsList.innerHTML = '';

        try {
            const res = await fetch('/api/backup/test-regex', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sender, subjectRegex })
            });

            if (!res.ok) {
                const err = await res.json();
                regexTestStatus.innerHTML = `<span class="text-danger"><i class="fa-solid fa-triangle-exclamation me-1"></i> Errore: ${err.message || 'Espressione non valida'}</span>`;
                return;
            }

            const data = await res.json();
            const matches = data.matches || [];

            if (matches.length === 0) {
                regexTestStatus.innerHTML = '<span class="text-warning"><i class="fa-solid fa-triangle-exclamation me-1"></i> Nessuna email corrisponde a questa configurazione. Controlla il mittente o l\'espressione regolare.</span>';
            } else {
                regexTestStatus.innerHTML = `<span class="text-success fw-semibold"><i class="fa-solid fa-circle-check me-1"></i> Trovate ${matches.length} email corrispondenti nella cache!</span>`;
                
                matches.forEach(m => {
                    const item = document.createElement('div');
                    item.className = 'fs-8 border-bottom border-secondary-subtle py-1 text-white-50 text-truncate';
                    const dateStr = new Date(parseInt(m.internalDate)).toLocaleString('it-IT');
                    item.innerHTML = `<strong class="text-white">${dateStr}</strong> - ${m.subject}`;
                    regexTestResultsList.appendChild(item);
                });
                
                regexTestResultsList.style.display = 'block';
            }
        } catch (error) {
            console.error('Error testing regex:', error);
            regexTestStatus.innerHTML = '<span class="text-danger"><i class="fa-solid fa-circle-exclamation me-1"></i> Errore di comunicazione con il server.</span>';
        }
    }

    if (btnTestRegexRun) {
        btnTestRegexRun.addEventListener('click', testCurrentRegex);
    }

    // Auto-run test on input changes
    const formRegexInput = document.getElementById('form-source-subject-regex');
    if (formRegexInput) {
        formRegexInput.addEventListener('input', debounceTestRegex);
    }
    const formSenderInput = document.getElementById('form-source-sender');
    if (formSenderInput) {
        formSenderInput.addEventListener('input', debounceTestRegex);
    }

    // -------------------------------------------------------------
    // Core API Requests
    // -------------------------------------------------------------
    async function fetchBackupSources() {
        try {
            const res = await fetch('/api/backup/sources');
            if (res.status === 401) {
                // Not authenticated
                showToast('Sessione scaduta. Reindirizzamento al login...', 'fa-triangle-exclamation', 'bg-danger');
                setTimeout(() => window.location.href = '/login.html', 2000);
                return;
            }
            const data = await res.json();
            backupSources = data.sources || [];
            updateKPIs();
            renderSourcesTable();
        } catch (error) {
            console.error('Error fetching backup sources:', error);
            showToast('Errore nel caricamento delle sorgenti.', 'fa-circle-exclamation', 'bg-danger');
        }
    }

    async function fetchAutoDiscovery() {
        try {
            const res = await fetch('/api/backup/discover');
            const data = await res.json();
            autoDiscoverySuggestions = data.suggestions || [];
            
            // Update discovery badge count
            if (autoDiscoverySuggestions.length > 0) {
                discoveryBadge.textContent = autoDiscoverySuggestions.length;
                discoveryBadge.classList.remove('d-none');
            } else {
                discoveryBadge.classList.add('d-none');
            }
            
            renderDiscoveryTable(autoDiscoverySuggestions);
        } catch (error) {
            console.error('Error in auto-discovery scan:', error);
        }
    }

    async function fetchExcludedEmails() {
        const trashTableBody = document.getElementById('trash-table-body');
        const trashBadge = document.getElementById('trash-badge');
        if (!trashTableBody) return;

        try {
            const res = await fetch('/api/backup/excluded-emails');
            const data = await res.json();
            const emails = data.emails || [];

            // Update trash badge count
            if (emails.length > 0) {
                if (trashBadge) {
                    trashBadge.textContent = emails.length;
                    trashBadge.classList.remove('d-none');
                }
            } else {
                if (trashBadge) {
                    trashBadge.classList.add('d-none');
                }
            }

            trashTableBody.innerHTML = '';
            if (emails.length === 0) {
                trashTableBody.innerHTML = `
                    <tr>
                        <td colspan="4" class="text-center py-5 text-muted">
                            <i class="fa-solid fa-trash-arrow-up text-secondary fs-3 mb-2"></i>
                            <p class="m-0">Nessuna e-mail nel cestino.</p>
                        </td>
                    </tr>
                `;
                return;
            }

            emails.forEach(email => {
                const tr = document.createElement('tr');
                const dateObj = new Date(parseInt(email.internalDate));
                const dateStr = dateObj.toLocaleString('it-IT');

                tr.innerHTML = `
                    <td>
                        <span class="fw-semibold text-light-emphasis">${escapeHtml(email.subject)}</span>
                    </td>
                    <td>
                        <span class="fs-7 text-muted"><i class="fa-regular fa-envelope me-1"></i>${escapeHtml(email.from)}</span>
                    </td>
                    <td>
                        <span class="fs-7 text-muted code-font">${dateStr}</span>
                    </td>
                    <td>
                        <button class="btn btn-sm btn-outline-success restore-email-btn" data-id="${email.id}">
                            <i class="fa-solid fa-trash-can-arrow-up me-1"></i> Ripristina
                        </button>
                    </td>
                `;

                tr.querySelector('.restore-email-btn').addEventListener('click', async (e) => {
                    const btn = e.currentTarget;
                    const id = btn.dataset.id;
                    try {
                        const restoreRes = await fetch('/api/backup/restore-email', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ emailId: id })
                        });
                        const restoreData = await restoreRes.json();
                        if (restoreData.success) {
                            showToast('Email ripristinata con successo.', 'fa-circle-check', 'bg-success');
                            fetchExcludedEmails();
                            fetchBackupSources();
                            fetchAutoDiscovery();
                        } else {
                            showToast('Errore durante il ripristino: ' + (restoreData.message || 'Errore sconosciuto'), 'fa-circle-exclamation', 'bg-danger');
                        }
                    } catch (err) {
                        console.error('Error restoring email:', err);
                        showToast('Errore di rete durante il ripristino.', 'fa-circle-exclamation', 'bg-danger');
                    }
                });

                trashTableBody.appendChild(tr);
            });
        } catch (error) {
            console.error('Error fetching excluded emails:', error);
            trashTableBody.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center py-5 text-danger">
                        <i class="fa-solid fa-circle-exclamation fs-3 mb-2"></i>
                        <p class="m-0">Errore durante il caricamento del cestino.</p>
                    </td>
                </tr>
            `;
        }
    }

    async function saveSourceForm() {
        const id = document.getElementById('form-source-id').value;
        const name = document.getElementById('form-source-name').value.trim();
        const sender = document.getElementById('form-source-sender').value.trim();
        const frequency = document.getElementById('form-source-frequency').value;
        const subjectRegex = document.getElementById('form-source-subject-regex').value.trim();
        const active = document.getElementById('form-source-active').checked;

        const payload = {
            name,
            sender,
            expectedFrequency: frequency,
            subjectRegex,
            fingerprint: '',
            active
        };

        const isEdit = !!id;
        const url = isEdit ? `/api/backup/sources/${id}` : '/api/backup/sources';
        const method = isEdit ? 'PUT' : 'POST';

        try {
            const res = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                showToast(isEdit ? 'Sorgente aggiornata con successo!' : 'Nuova sorgente aggiunta al monitoraggio!', 'fa-circle-check', 'bg-success');
                sourceModal.hide();
                fetchBackupSources();
                fetchAutoDiscovery();
            } else {
                const errData = await res.json();
                showToast(`Salvataggio fallito: ${errData.message || 'Errore di validazione'}`, 'fa-circle-exclamation', 'bg-danger');
            }
        } catch (error) {
            console.error('Error saving backup source form:', error);
            showToast('Errore durante la comunicazione con il server.', 'fa-circle-exclamation', 'bg-danger');
        }
    }

    async function toggleActiveState(id, state) {
        try {
            const res = await fetch(`/api/backup/sources/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: state })
            });

            if (res.ok) {
                showToast(state ? 'Monitoraggio riattivato.' : 'Monitoraggio messo in pausa.', 'fa-circle-info', 'bg-info');
                fetchBackupSources();
            } else {
                showToast('Impossibile aggiornare lo stato attivo.', 'fa-circle-exclamation', 'bg-danger');
            }
        } catch (error) {
            console.error('Error toggling active state:', error);
        }
    }

    async function deleteBackupSource(id, name) {
        if (!confirm(`Sei sicuro di voler eliminare la sorgente "${name}"?\nNon riceverai più notifiche o allarmi per questo backup.`)) {
            return;
        }

        try {
            const res = await fetch(`/api/backup/sources/${id}`, {
                method: 'DELETE'
            });

            if (res.ok) {
                showToast('Sorgente eliminata con successo.', 'fa-trash-can', 'bg-success');
                fetchBackupSources();
                fetchAutoDiscovery();
            } else {
                showToast('Errore durante l\'eliminazione.', 'fa-circle-exclamation', 'bg-danger');
            }
        } catch (error) {
            console.error('Error deleting source:', error);
        }
    }

    // -------------------------------------------------------------
    // UI Rendering Logic
    // -------------------------------------------------------------
    function updateKPIs() {
        let total = backupSources.length;
        let ok = 0;
        let warning = 0;
        let missing = 0;
        let failed = 0;

        backupSources.forEach(s => {
            if (!s.active) return; // exclude inactive from active KPI metrics calculation
            
            if (s.currentStatus === 'success' || s.currentStatus === 'healthy') {
                ok++;
            } else if (s.currentStatus === 'warning') {
                warning++;
            } else if (s.currentStatus === 'missing') {
                missing++;
            } else if (s.currentStatus === 'failed') {
                failed++;
            }
        });

        // Update elements
        kpiTotal.textContent = total;
        kpiOk.textContent = ok;
        if (kpiWarning) kpiWarning.textContent = warning;
        kpiMissing.textContent = missing;
        kpiFailed.textContent = failed;
    }

    function renderSourcesTable() {
        sourcesTableBody.innerHTML = '';

        // Filter and search logic
        const filteredSources = backupSources.filter(s => {
            // Apply Status Filter
            if (currentFilter === 'success' && s.currentStatus !== 'success' && s.currentStatus !== 'healthy') return false;
            if (currentFilter === 'warning' && s.currentStatus !== 'warning') return false;
            if (currentFilter === 'missing' && s.currentStatus !== 'missing') return false;
            if (currentFilter === 'failed' && s.currentStatus !== 'failed') return false;
            if (currentFilter === 'no_data' && s.currentStatus !== 'no_data') return false;
            if (currentFilter === 'inactive' && s.active) return false;
            if (currentFilter !== 'inactive' && !s.active && currentFilter !== 'all') return false;

            // Apply Search Query
            if (searchQuery) {
                const term = searchQuery;
                const matchesName = s.name.toLowerCase().includes(term);
                const matchesSender = (s.sender || '').toLowerCase().includes(term);
                const matchesFp = (s.fingerprint || '').toLowerCase().includes(term);
                return matchesName || matchesSender || matchesFp;
            }

            return true;
        });

        if (filteredSources.length === 0) {
            sourcesTableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center py-4 text-muted">
                        Nessun flusso corrispondente ai filtri impostati.
                    </td>
                </tr>
            `;
            return;
        }

        filteredSources.forEach(s => {
            const tr = document.createElement('tr');
            
            // Status Icon Class
            let indicatorClass = 'status-indicator';
            let statusText = 'Sconosciuto';
            let statusBadgeClass = 'bg-secondary';

            if (!s.active) {
                indicatorClass += ' status-inactive';
                statusText = 'Disattivato';
            } else {
                switch (s.currentStatus) {
                    case 'success':
                    case 'healthy':
                        indicatorClass += ' status-success';
                        statusText = 'Regolare';
                        statusBadgeClass = 'bg-success';
                        break;
                    case 'missing':
                        indicatorClass += ' status-missing';
                        statusText = 'Mancante';
                        statusBadgeClass = 'bg-warning text-dark';
                        break;
                    case 'warning':
                        indicatorClass += ' status-warning'; // Wait, let's map to warning/failed alert
                        statusText = 'Anomalo';
                        statusBadgeClass = 'bg-warning text-dark';
                        break;
                    case 'failed':
                        indicatorClass += ' status-failed';
                        statusText = 'Errore';
                        statusBadgeClass = 'bg-danger';
                        break;
                    case 'no_data':
                        indicatorClass += ' status-no_data';
                        statusText = 'Senza Dati';
                        statusBadgeClass = 'bg-info text-dark';
                        break;
                }
            }

            // Stats parsing
            const avgTime = s.stats ? formatMinutes(s.stats.mean) : '--:--';
            const stdDev = s.stats ? `± ${s.stats.stdDev} min` : '--';
            const limitTime = s.stats ? formatMinutes(s.stats.maxTime) : '--:--';

            // Last Received Details
            let lastReceivedText = 'Mai ricevuto';
            let lastStatusBadge = '';
            if (s.lastRun) {
                const dateObj = new Date(parseInt(s.lastRun.internalDate));
                lastReceivedText = `${dateObj.toLocaleString('it-IT')} (${getRelativeTimeStr(dateObj)})`;
                lastStatusBadge = `<span class="run-status-badge status-${s.lastRun.status} ms-2">${s.lastRun.status.toUpperCase()}</span>`;
            }

            // Inactive opacity fade
            if (!s.active) {
                tr.style.opacity = '0.6';
            }

            tr.innerHTML = `
                <td>
                    <div class="d-flex align-items-center gap-2">
                        <span class="${indicatorClass}" title="${statusText}"></span>
                        <span class="fs-7 text-uppercase fw-semibold d-none d-lg-inline">${statusText}</span>
                    </div>
                </td>
                <td>
                    <div class="fw-semibold text-primary-emphasis">${escapeHtml(s.name)}</div>
                    <div class="fs-7 text-muted d-flex align-items-center gap-2 flex-wrap">
                        <span><i class="fa-regular fa-envelope me-1"></i>${escapeHtml(s.sender)}</span>
                        <span class="text-secondary-subtle">|</span>
                        <span class="code-font text-info" title="Regex dell'oggetto"><i class="fa-solid fa-code me-1"></i>${escapeHtml(s.subjectRegex)}</span>
                    </div>
                </td>
                <td>
                    <span class="badge-frequency">${translateFrequency(s.expectedFrequency)}</span>
                </td>
                <td>
                    <div class="code-font fw-medium">${avgTime}</div>
                    <div class="fs-7 text-muted">${stdDev}</div>
                </td>
                <td>
                    <div class="code-font fw-medium text-warning-emphasis">${limitTime}</div>
                </td>
                <td>
                    <div class="fs-7 fw-medium">${lastReceivedText}</div>
                    <div class="fs-7 d-flex align-items-center">${lastStatusBadge}</div>
                </td>
                <td>
                    <div class="action-btn-group">
                        <button class="btn btn-sm btn-outline-info view-runs-btn" title="Cronologia Runs" data-id="${s.id}" data-fp="${s.fingerprint}">
                            <i class="fa-solid fa-clock-rotate-left"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-warning edit-source-btn" title="Modifica Configurazione" data-id="${s.id}">
                            <i class="fa-solid fa-pen-to-square"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger delete-source-btn" title="Rimuovi Monitoraggio" data-id="${s.id}" data-name="${escapeHtml(s.name)}">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                    <div class="form-check form-switch mt-2">
                        <input class="form-check-input active-toggle-switch" type="checkbox" data-id="${s.id}" ${s.active ? 'checked' : ''} title="Attiva/Disattiva">
                    </div>
                </td>
            `;

            // Bind events for buttons inside the row
            tr.querySelector('.view-runs-btn').addEventListener('click', (e) => {
                const btn = e.currentTarget;
                openRunsHistory(btn.dataset.id, btn.dataset.fp);
            });

            tr.querySelector('.edit-source-btn').addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                openEditModal(id);
            });

            tr.querySelector('.delete-source-btn').addEventListener('click', (e) => {
                const btn = e.currentTarget;
                deleteBackupSource(btn.dataset.id, btn.dataset.name);
            });

            tr.querySelector('.active-toggle-switch').addEventListener('change', (e) => {
                const id = e.currentTarget.dataset.id;
                const state = e.currentTarget.checked;
                toggleActiveState(id, state);
            });

            sourcesTableBody.appendChild(tr);
        });
    }

    function updateDiscoverHeaderIcons() {
        const discoverHeaderRow = document.getElementById('discover-table-header-row');
        if (!discoverHeaderRow) return;
        
        discoverHeaderRow.querySelectorAll('th.sortable-th').forEach(th => {
            const sortField = th.dataset.sort;
            const icon = th.querySelector('i');
            if (!icon) return;
            
            if (discoverSortField === sortField) {
                if (discoverSortDirection === 'asc') {
                    icon.className = 'fa-solid fa-sort-up text-warning ms-1';
                } else {
                    icon.className = 'fa-solid fa-sort-down text-warning ms-1';
                }
            } else {
                icon.className = 'fa-solid fa-sort text-muted opacity-50 ms-1';
            }
        });
    }

    function renderDiscoveryTable(suggestions) {
        discoverTableBody.innerHTML = '';
        updateDiscoverHeaderIcons();

        if (suggestions.length === 0) {
            discoverTableBody.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center py-5 text-muted">
                        <i class="fa-solid fa-square-check text-success fs-3 mb-2"></i>
                        <p class="m-0">Nessuna nuova sorgente di backup rilevata automaticamente nella cache.</p>
                        <span class="fs-7 text-secondary">Tutti i backup rilevabili sono già configurati per il monitoraggio.</span>
                    </td>
                </tr>
            `;
            return;
        }

        // Apply Search Query filtering
        const filteredSuggestions = suggestions.filter(s => {
            if (discoverSearchQuery) {
                const term = discoverSearchQuery;
                const matchesName = s.name.toLowerCase().includes(term);
                const matchesSender = (s.sender || '').toLowerCase().includes(term);
                const matchesFp = (s.fingerprint || '').toLowerCase().includes(term);
                return matchesName || matchesSender || matchesFp;
            }
            return true;
        });

        // Apply Sorting
        if (discoverSortField) {
            filteredSuggestions.sort((a, b) => {
                let valA, valB;
                if (discoverSortField === 'name') {
                    valA = a.name.toLowerCase();
                    valB = b.name.toLowerCase();
                } else if (discoverSortField === 'frequency') {
                    const frequencyWeight = { 'hourly': 1, 'daily': 2, 'weekly': 3 };
                    valA = frequencyWeight[a.expectedFrequency] || 99;
                    valB = frequencyWeight[b.expectedFrequency] || 99;
                } else if (discoverSortField === 'samples') {
                    valA = a.emailCount || 0;
                    valB = b.emailCount || 0;
                } else if (discoverSortField === 'action') {
                    const aImported = a.isImported || backupSources.some(src => 
                        src.sender.toLowerCase().trim() === a.sender.toLowerCase().trim() && 
                        src.fingerprint.toLowerCase().trim() === a.fingerprint.toLowerCase().trim()
                    );
                    const bImported = b.isImported || backupSources.some(src => 
                        src.sender.toLowerCase().trim() === b.sender.toLowerCase().trim() && 
                        src.fingerprint.toLowerCase().trim() === b.fingerprint.toLowerCase().trim()
                    );
                    valA = aImported ? 1 : 0;
                    valB = bImported ? 1 : 0;
                }
                
                if (valA < valB) return discoverSortDirection === 'asc' ? -1 : 1;
                if (valA > valB) return discoverSortDirection === 'asc' ? 1 : -1;
                return 0;
            });
        }

        if (filteredSuggestions.length === 0) {
            discoverTableBody.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center py-5 text-muted">
                        <i class="fa-solid fa-magnifying-glass text-secondary fs-3 mb-2"></i>
                        <p class="m-0">Nessuna sorgente suggerita corrisponde alla ricerca.</p>
                    </td>
                </tr>
            `;
            return;
        }

        filteredSuggestions.forEach(s => {
            // Check if already imported
            const isAlreadyImported = s.isImported || backupSources.some(src => 
                src.sender.toLowerCase().trim() === s.sender.toLowerCase().trim() && 
                src.fingerprint.toLowerCase().trim() === s.fingerprint.toLowerCase().trim()
            );

            const tr = document.createElement('tr');
            if (isAlreadyImported) {
                tr.style.opacity = '0.75';
            }

            let actionBtnHtml = '';
            if (isAlreadyImported) {
                actionBtnHtml = `
                    <button class="btn btn-sm btn-outline-secondary import-suggest-btn" disabled>
                        <i class="fa-solid fa-circle-check text-success me-1"></i> Già Importato
                    </button>
                `;
            } else {
                actionBtnHtml = `
                    <div class="d-flex gap-2">
                        <button class="btn btn-sm btn-warning import-suggest-btn" 
                            data-name="${escapeHtml(s.name)}" 
                            data-sender="${escapeHtml(s.sender)}" 
                            data-regex="${escapeHtml(s.subjectRegex)}" 
                            data-fingerprint="${escapeHtml(s.fingerprint)}" 
                            data-frequency="${s.expectedFrequency}">
                            <i class="fa-solid fa-file-import me-1"></i> Importa
                        </button>
                        <button class="btn btn-sm btn-outline-danger reject-suggest-btn"
                            title="Rifiuta (Sposta tutte le email nel cestino)"
                            data-name="${escapeHtml(s.name)}" 
                            data-sender="${escapeHtml(s.sender)}" 
                            data-regex="${escapeHtml(s.subjectRegex)}" 
                            data-fingerprint="${escapeHtml(s.fingerprint)}">
                            <i class="fa-solid fa-trash-can"></i> Rifiuta
                        </button>
                    </div>
                `;
            }

            tr.innerHTML = `
                <td>
                    <div class="d-flex align-items-center flex-wrap">
                        <span class="fw-bold text-primary-emphasis"><i class="fa-solid fa-sparkles text-warning me-2"></i>${escapeHtml(s.name)}</span>
                        ${isAlreadyImported ? `<span class="badge bg-success-subtle text-success border border-success-subtle ms-2 fs-8 py-0.5 px-2"><i class="fa-solid fa-circle-check me-1"></i>In Monitoraggio</span>` : ''}
                    </div>
                    <div class="fs-7 text-muted d-flex align-items-center gap-2 flex-wrap mt-1">
                        <span><i class="fa-regular fa-envelope me-1"></i>${escapeHtml(s.sender)}</span>
                        <span class="text-secondary-subtle">|</span>
                        <span class="code-font text-info" title="Regex dell'oggetto"><i class="fa-solid fa-code me-1"></i>${escapeHtml(s.subjectRegex)}</span>
                        <span class="text-secondary-subtle">|</span>
                        <span class="badge bg-secondary-subtle text-secondary fs-8 code-font px-1.5 py-0" title="Fingerprint">Fp: ${escapeHtml(s.fingerprint)}</span>
                    </div>
                </td>
                <td>
                    <span class="badge-frequency">${translateFrequency(s.expectedFrequency)}</span>
                </td>
                <td>
                    <button class="btn btn-sm btn-outline-warning view-suggested-runs-btn py-1 px-2"
                        style="border-radius: 30px; font-size: 0.8rem;"
                        title="Visualizza le email di questa sorgente"
                        data-name="${escapeHtml(s.name)}"
                        data-sender="${escapeHtml(s.sender)}"
                        data-regex="${escapeHtml(s.subjectRegex)}"
                        data-fingerprint="${escapeHtml(s.fingerprint)}">
                        <i class="fa-solid fa-envelope-open me-1"></i> ${s.emailCount} email trovate
                    </button>
                </td>
                <td>
                    ${actionBtnHtml}
                </td>
            `;

            if (!isAlreadyImported) {
                tr.querySelector('.import-suggest-btn').addEventListener('click', (e) => {
                    const btn = e.currentTarget;
                    openImportModal(btn.dataset);
                });

                const rejectBtn = tr.querySelector('.reject-suggest-btn');
                if (rejectBtn) {
                    rejectBtn.addEventListener('click', async (e) => {
                        const btn = e.currentTarget;
                        const name = btn.dataset.name;
                        const sender = btn.dataset.sender;
                        const regex = btn.dataset.regex;
                        const fingerprint = btn.dataset.fingerprint;

                        if (!confirm(`Sei sicuro di voler rifiutare il flusso "${name}"? Tutte le sue email verranno escluse e spostate nel cestino.`)) {
                            return;
                        }

                        try {
                            const url = `/api/backup/runs/${encodeURIComponent(fingerprint)}?sender=${encodeURIComponent(sender)}&subjectRegex=${encodeURIComponent(regex)}`;
                            const res = await fetch(url);
                            const data = await res.json();
                            const runs = data.runs || [];

                            if (runs.length === 0) {
                                showToast('Nessuna email trovata per questo suggerimento.', 'fa-circle-exclamation', 'bg-warning');
                                return;
                            }

                            let successCount = 0;
                            for (const run of runs) {
                                const excludeRes = await fetch('/api/backup/exclude-email', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ emailId: run.id })
                                });
                                const excludeData = await excludeRes.json();
                                if (excludeData.success) {
                                    successCount++;
                                }
                            }

                            showToast(`Escluse ${successCount} email di "${name}".`, 'fa-trash-can', 'bg-warning');
                            fetchAutoDiscovery();
                            fetchExcludedEmails();
                        } catch (err) {
                            console.error('Error rejecting suggested flow:', err);
                            showToast('Errore durante il rifiuto del flusso.', 'fa-circle-exclamation', 'bg-danger');
                        }
                    });
                }
            }

            const viewSuggestBtn = tr.querySelector('.view-suggested-runs-btn');
            if (viewSuggestBtn) {
                viewSuggestBtn.addEventListener('click', (e) => {
                    const btn = e.currentTarget;
                    openSuggestedRunsHistory(
                        btn.dataset.fingerprint,
                        btn.dataset.sender,
                        btn.dataset.regex,
                        btn.dataset.name
                    );
                });
            }

            discoverTableBody.appendChild(tr);
        });
    }

    // -------------------------------------------------------------
    // Modal Actions Helper
    // -------------------------------------------------------------
    function openEditModal(id) {
        const s = backupSources.find(src => src.id === id);
        if (!s) return;

        document.getElementById('sourceModalLabel').innerHTML = '<i class="fa-solid fa-pen-to-square text-warning me-2"></i>Modifica Sorgente Backup';
        document.getElementById('form-source-id').value = s.id;
        document.getElementById('form-source-name').value = s.name;
        document.getElementById('form-source-sender').value = s.sender;
        document.getElementById('form-source-frequency').value = s.expectedFrequency;
        document.getElementById('form-source-subject-regex').value = s.subjectRegex;
        document.getElementById('form-source-active').checked = s.active;
        hideRegexAssistant();

        sourceModal.show();
        testCurrentRegex();
    }

    function openImportModal(data) {
        document.getElementById('sourceModalLabel').innerHTML = '<i class="fa-solid fa-file-import text-warning me-2"></i>Importa Sorgente Suggerita';
        document.getElementById('form-source-id').value = '';
        document.getElementById('form-source-name').value = data.name;
        document.getElementById('form-source-sender').value = data.sender;
        document.getElementById('form-source-frequency').value = data.frequency;
        document.getElementById('form-source-subject-regex').value = data.regex;
        document.getElementById('form-source-active').checked = true;
        hideRegexAssistant();

        sourceModal.show();
        testCurrentRegex();
    }

    // -------------------------------------------------------------
    // Runs History Panel Log (Offcanvas Drawer)
    // -------------------------------------------------------------
    async function openRunsHistory(id, fingerprint) {
        const source = backupSources.find(s => s.id === id);
        if (source) {
            document.getElementById('offcanvas-flow-name').innerHTML = `${escapeHtml(source.name)} <span class="badge bg-success-subtle text-success border border-success-subtle fs-8 ms-2">Monitorato</span>`;
        } else {
            document.getElementById('offcanvas-flow-name').textContent = 'Storico Backup';
        }
        
        // Populate Mini Statistics header
        if (source && source.stats) {
            document.getElementById('offcanvas-stat-mean').textContent = formatMinutes(source.stats.mean);
            document.getElementById('offcanvas-stat-max').textContent = formatMinutes(source.stats.maxTime);
            document.getElementById('offcanvas-stat-std').textContent = `${source.stats.stdDev} min`;
        } else {
            document.getElementById('offcanvas-stat-mean').textContent = '--';
            document.getElementById('offcanvas-stat-max').textContent = '--';
            document.getElementById('offcanvas-stat-std').textContent = '--';
        }

        const runsContainer = document.getElementById('offcanvas-runs-container');
        runsContainer.innerHTML = `
            <div class="text-center py-4 text-muted">
                <div class="spinner-border spinner-border-sm text-warning" role="status"></div>
                <p class="mt-2 fs-7">Caricamento log delle e-mail...</p>
            </div>
        `;
        
        runsOffcanvas.show();

        try {
            const res = await fetch(`/api/backup/runs/${encodeURIComponent(id)}`);
            const data = await res.json();
            const runs = data.runs || [];
            
            runsContainer.innerHTML = '';
            if (runs.length === 0) {
                runsContainer.innerHTML = `
                    <div class="text-center py-4 text-muted">
                        <i class="fa-solid fa-inbox fs-3 mb-2"></i>
                        <p class="fs-7 m-0">Nessuna e-mail trovata nella cache per questo fingerprint.</p>
                    </div>
                `;
                return;
            }

            runs.forEach(run => {
                const card = document.createElement('div');
                card.className = `run-log-card run-${run.status}`;
                
                const dateObj = new Date(parseInt(run.internalDate));
                const dateStr = dateObj.toLocaleString('it-IT');
                const relTime = getRelativeTimeStr(dateObj);

                let statusBadgeClass = 'status-success';
                let statusLabel = 'SUCCESSO';
                if (run.status === 'failed') {
                    statusBadgeClass = 'status-failed';
                    statusLabel = 'FALLITO';
                } else if (run.status === 'warning') {
                    statusBadgeClass = 'status-warning';
                    statusLabel = 'WARNING';
                }

                card.innerHTML = `
                    <div class="d-flex justify-content-between align-items-center mb-2 fs-7">
                        <span class="run-status-badge ${statusBadgeClass}">${statusLabel}</span>
                        <div class="d-flex align-items-center gap-2">
                            <span class="text-muted code-font">${dateStr} (${relTime})</span>
                            <button class="btn btn-sm btn-link text-danger p-0 exclude-email-btn" title="Escludi (Sposta nel Cestino)" data-id="${run.id}">
                                <i class="fa-solid fa-trash-can"></i>
                            </button>
                        </div>
                    </div>
                    <div class="fw-semibold fs-7 mb-1 text-primary-emphasis text-truncate" title="${escapeHtml(run.subject)}">
                        ${escapeHtml(run.subject)}
                    </div>
                    <div class="text-muted fs-8 text-truncate">
                        ${escapeHtml(run.snippet || 'Senza corpo e-mail')}
                    </div>
                `;

                // Add click listener to open detailed email body modal
                card.addEventListener('click', () => {
                    openEmailDetailModal(run);
                });

                // Add click listener to exclude button
                card.querySelector('.exclude-email-btn').addEventListener('click', async (e) => {
                    e.stopPropagation(); // Prevent opening detail modal
                    if (!confirm('Sei sicuro di voler escludere questa email? Verrà spostata nel cestino.')) return;
                    try {
                        const res = await fetch('/api/backup/exclude-email', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ emailId: run.id })
                        });
                        const resData = await res.json();
                        if (resData.success) {
                            showToast('Email esclusa con successo.', 'fa-trash-can', 'bg-warning');
                            openRunsHistory(id, fingerprint);
                            fetchBackupSources();
                            fetchAutoDiscovery();
                            fetchExcludedEmails();
                        } else {
                            showToast('Errore durante l\'esclusione: ' + (resData.message || 'Errore sconosciuto'), 'fa-circle-exclamation', 'bg-danger');
                        }
                    } catch (err) {
                        console.error('Error excluding email:', err);
                        showToast('Errore di rete.', 'fa-circle-exclamation', 'bg-danger');
                    }
                });

                runsContainer.appendChild(card);
            });
        } catch (error) {
            console.error('Error fetching runs history:', error);
            runsContainer.innerHTML = `
                <div class="text-center py-4 text-danger">
                    <i class="fa-solid fa-circle-exclamation fs-3 mb-2"></i>
                    <p class="fs-7 m-0">Errore durante il recupero dello storico.</p>
                </div>
            `;
        }
    }

    async function openSuggestedRunsHistory(fingerprint, sender, subjectRegex, name) {
        document.getElementById('offcanvas-flow-name').innerHTML = `${escapeHtml(name)} <span class="badge bg-warning-subtle text-warning border border-warning-subtle fs-8 ms-2">Suggerito</span>`;
        
        // Populate Mini Statistics header (empty/defaults for suggested flows)
        document.getElementById('offcanvas-stat-mean').textContent = '--';
        document.getElementById('offcanvas-stat-max').textContent = '--';
        document.getElementById('offcanvas-stat-std').textContent = '--';

        const runsContainer = document.getElementById('offcanvas-runs-container');
        runsContainer.innerHTML = `
            <div class="text-center py-4 text-muted">
                <div class="spinner-border spinner-border-sm text-warning" role="status"></div>
                <p class="mt-2 fs-7">Caricamento log delle e-mail...</p>
            </div>
        `;
        
        runsOffcanvas.show();

        try {
            const url = `/api/backup/runs/${encodeURIComponent(fingerprint)}?sender=${encodeURIComponent(sender)}&subjectRegex=${encodeURIComponent(subjectRegex)}`;
            const res = await fetch(url);
            const data = await res.json();
            const runs = data.runs || [];
            
            runsContainer.innerHTML = '';
            if (runs.length === 0) {
                runsContainer.innerHTML = `
                    <div class="text-center py-4 text-muted">
                        <i class="fa-solid fa-inbox fs-3 mb-2"></i>
                        <p class="fs-7 m-0">Nessuna e-mail trovata nella cache per questa sorgente.</p>
                    </div>
                `;
                return;
            }

            runs.forEach(run => {
                const card = document.createElement('div');
                card.className = `run-log-card run-${run.status}`;
                
                const dateObj = new Date(parseInt(run.internalDate));
                const dateStr = dateObj.toLocaleString('it-IT');
                const relTime = getRelativeTimeStr(dateObj);

                let statusBadgeClass = 'status-success';
                let statusLabel = 'SUCCESSO';
                if (run.status === 'failed') {
                    statusBadgeClass = 'status-failed';
                    statusLabel = 'FALLITO';
                } else if (run.status === 'warning') {
                    statusBadgeClass = 'status-warning';
                    statusLabel = 'WARNING';
                }

                card.innerHTML = `
                    <div class="d-flex justify-content-between align-items-center mb-2 fs-7">
                        <span class="run-status-badge ${statusBadgeClass}">${statusLabel}</span>
                        <div class="d-flex align-items-center gap-2">
                            <span class="text-muted code-font">${dateStr} (${relTime})</span>
                            <button class="btn btn-sm btn-link text-danger p-0 exclude-email-btn" title="Escludi (Sposta nel Cestino)" data-id="${run.id}">
                                <i class="fa-solid fa-trash-can"></i>
                            </button>
                        </div>
                    </div>
                    <div class="fw-semibold fs-7 mb-1 text-primary-emphasis text-truncate" title="${escapeHtml(run.subject)}">
                        ${escapeHtml(run.subject)}
                    </div>
                    <div class="text-muted fs-8 text-truncate">
                        ${escapeHtml(run.snippet || 'Senza corpo e-mail')}
                    </div>
                `;

                // Add click listener to open detailed email body modal
                card.addEventListener('click', () => {
                    openEmailDetailModal(run);
                });

                // Add click listener to exclude button
                card.querySelector('.exclude-email-btn').addEventListener('click', async (e) => {
                    e.stopPropagation(); // Prevent opening detail modal
                    if (!confirm('Sei sicuro di voler escludere questa email? Verrà spostata nel cestino.')) return;
                    try {
                        const res = await fetch('/api/backup/exclude-email', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ emailId: run.id })
                        });
                        const resData = await res.json();
                        if (resData.success) {
                            showToast('Email esclusa con successo.', 'fa-trash-can', 'bg-warning');
                            openSuggestedRunsHistory(fingerprint, sender, subjectRegex, name);
                            fetchAutoDiscovery();
                            fetchExcludedEmails();
                        } else {
                            showToast('Errore durante l\'esclusione: ' + (resData.message || 'Errore sconosciuto'), 'fa-circle-exclamation', 'bg-danger');
                        }
                    } catch (err) {
                        console.error('Error excluding email:', err);
                        showToast('Errore di rete.', 'fa-circle-exclamation', 'bg-danger');
                    }
                });

                runsContainer.appendChild(card);
            });
        } catch (error) {
            console.error('Error fetching runs history:', error);
            runsContainer.innerHTML = `
                <div class="text-center py-4 text-danger">
                    <i class="fa-solid fa-circle-exclamation fs-3 mb-2"></i>
                    <p class="fs-7 m-0">Errore durante il recupero dello storico.</p>
                </div>
            `;
        }
    }

    function openEmailDetailModal(email) {
        document.getElementById('email-detail-subject').textContent = email.subject;
        document.getElementById('email-detail-from').textContent = email.from;
        
        const dateObj = new Date(parseInt(email.internalDate));
        document.getElementById('email-detail-date').textContent = dateObj.toLocaleString('it-IT');
        
        // Status badge configuration
        const badge = document.getElementById('email-detail-status-badge');
        badge.className = 'badge';
        if (email.status === 'failed') {
            badge.classList.add('bg-danger');
            badge.textContent = 'FALLITO';
        } else if (email.status === 'warning') {
            badge.classList.add('bg-warning', 'text-dark');
            badge.textContent = 'WARNING';
        } else {
            badge.classList.add('bg-success');
            badge.textContent = 'SUCCESS';
        }

        // Load content: prefer HTML, fall back to snippet or body
        const container = document.getElementById('email-detail-body');
        if (email.bodyHtml) {
            container.innerHTML = email.bodyHtml;
        } else if (email.body) {
            container.textContent = email.body;
        } else {
            container.textContent = email.snippet || 'Nessun contenuto disponibile.';
        }

        emailDetailModal.show();
    }

    // -------------------------------------------------------------
    // Helper Format Utilities
    // -------------------------------------------------------------
    function formatMinutes(minutes) {
        if (minutes === undefined || minutes === null) return '--:--';
        const wrapped = ((minutes % 1440) + 1440) % 1440;
        const h = Math.floor(wrapped / 60).toString().padStart(2, '0');
        const m = Math.floor(wrapped % 60).toString().padStart(2, '0');
        
        // If minutes wrap into next day, add a +1d flag
        if (minutes >= 1440) {
            return `${h}:${m} (+1g)`;
        }
        return `${h}:${m}`;
    }

    function translateFrequency(freq) {
        switch (freq) {
            case 'hourly': return 'Orario';
            case 'daily': return 'Giornaliero';
            case 'weekly': return 'Settimanale';
            default: return freq;
        }
    }

    function getRelativeTimeStr(date) {
        const now = new Date();
        const seconds = Math.floor((now - date) / 1000);
        if (seconds < 60) return 'ora';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} min fa`;
        const hours = Math.floor(minutes / 60);
        
        // Calculate date boundaries (set to midnight)
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        
        // Difference in days by calculating calendar date difference
        const diffMs = startOfToday - startOfDate;
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) {
            return `${hours} ore fa`;
        }
        if (diffDays === 1) {
            return 'ieri';
        }
        if (diffDays === 2) {
            return 'l\'altro ieri';
        }
        return `${diffDays} giorni fa`;
    }

    function escapeHtml(string) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return String(string).replace(/[&<>"']/g, function(m) { return map[m]; });
    }

    // -------------------------------------------------------------
    // Toast Notification System
    // -------------------------------------------------------------
    function showToast(message, iconClass = 'fa-circle-info', bgClass = 'bg-info') {
        const toastMessageEl = document.getElementById('toast-message');
        const toastIconEl = document.getElementById('toast-icon');
        
        toastMessageEl.textContent = message;
        
        // Set icon class
        toastIconEl.className = `fa-solid ${iconClass} me-2 fs-5`;
        
        // Remove prior background colors
        toastEl.classList.remove('bg-info', 'bg-success', 'bg-warning', 'bg-danger', 'text-dark');
        toastEl.classList.add(bgClass);
        if (bgClass.includes('warning')) {
            toastEl.classList.add('text-dark');
        }
        
        appToast.show();
    }
});