// Assistente AI sulle email. Il testo arriva da email e LLM: si scrive solo con textContent, mai come HTML.
(function () {
    const panel = document.getElementById('assistant-panel');
    const toggle = document.getElementById('toggle-assistant-panel');
    if (!panel || !toggle) return;

    const closeBtn = document.getElementById('assistant-close');
    const form = document.getElementById('assistant-form');
    const input = document.getElementById('assistant-input');
    const submit = document.getElementById('assistant-submit');
    const stopBtn = document.getElementById('assistant-stop');
    const log = document.getElementById('assistant-log');
    const footer = document.getElementById('assistant-index-info');

    let controller = null;
    let timer = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function scrollToEnd() {
        log.scrollTop = log.scrollHeight;
    }

    function renderSources(container, title, sources) {
        container.replaceChildren();
        if (!sources.length) return;
        container.appendChild(el('div', 'assistant-sources-title', title));
        for (const source of sources) {
            const link = el('a', 'assistant-source');
            link.href = `/?emailId=${encodeURIComponent(source.email_id)}`;
            link.target = '_blank';
            link.rel = 'noopener';
            link.dataset.label = source.label;
            link.appendChild(el('span', 'assistant-source-label', source.label));
            const body = el('span', 'assistant-source-body');
            body.appendChild(el('span', 'assistant-source-subject', source.subject));
            body.appendChild(el('span', 'assistant-source-meta', `${source.from} · ${source.date}`));
            link.appendChild(body);
            container.appendChild(link);
        }
    }

    // Trasforma [E1] in un riferimento alla fonte corrispondente.
    function renderAnswer(container, answer, sources) {
        container.replaceChildren();
        const known = new Set(sources.map(s => s.label));
        for (const part of answer.split(/(\[E\d+\])/)) {
            const match = part.match(/^\[(E\d+)\]$/);
            if (match && known.has(match[1])) {
                const source = sources.find(s => s.label === match[1]);
                const link = el('a', 'assistant-cite', match[1]);
                link.href = `/?emailId=${encodeURIComponent(source.email_id)}`;
                link.target = '_blank';
                link.rel = 'noopener';
                link.title = source.subject;
                container.appendChild(link);
            } else if (part) {
                container.appendChild(document.createTextNode(part));
            }
        }
    }

    function setBusy(busy) {
        input.disabled = busy;
        submit.classList.toggle('d-none', busy);
        stopBtn.classList.toggle('d-none', !busy);
        if (!busy) input.focus();
    }

    function startTimer(statusNode, getText) {
        const started = Date.now();
        const update = () => {
            statusNode.textContent = `${getText()} ${Math.round((Date.now() - started) / 1000)} s`;
        };
        update();
        timer = setInterval(update, 1000);
    }

    function stopTimer(statusNode) {
        clearInterval(timer);
        timer = null;
        statusNode.remove();
    }

    function handleEvent(event, turn, state) {
        if (event.type === 'sources') {
            state.candidates = event.sources;
            renderSources(turn.sources, 'Email trovate', event.sources);
            state.statusText = event.sources.length
                ? `Sto leggendo ${event.sources.length === 1 ? '1 email' : `${event.sources.length} email`}…`
                : 'Controllo…';
        } else if (event.type === 'token') {
            if (!state.started) {
                state.started = true;
                state.statusText = 'Sto scrivendo…';
                turn.answer.classList.remove('assistant-answer-muted');
            }
            state.text += event.text;
            renderAnswer(turn.answer, state.text, state.candidates);
        } else if (event.type === 'final') {
            state.done = true;
            turn.answer.classList.toggle('assistant-answer-muted', !event.found);
            renderAnswer(turn.answer, event.answer, event.sources);
            renderSources(turn.sources, event.kind === 'list' ? 'Email' : 'Fonti', event.sources);
            renderSources(turn.related, event.found ? 'Altre email collegate' : 'Email forse collegate', event.related || []);
        } else if (event.type === 'error') {
            throw new Error(event.message);
        }
        scrollToEnd();
    }

    async function ask(question) {
        log.querySelector('.assistant-empty')?.remove();
        log.appendChild(el('div', 'assistant-question', question));
        const turn = {
            status: el('div', 'assistant-status'),
            answer: el('div', 'assistant-answer'),
            sources: el('div', 'assistant-sources'),
            related: el('div', 'assistant-sources')
        };
        const wrapper = el('div', 'assistant-turn');
        wrapper.append(turn.status, turn.answer, turn.sources, turn.related);
        log.appendChild(wrapper);
        scrollToEnd();

        const state = { candidates: [], text: '', started: false, done: false, statusText: 'Cerco nelle email…' };
        controller = new AbortController();
        setBusy(true);
        startTimer(turn.status, () => state.statusText);

        try {
            const res = await fetch('/api/assistant/ask-stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ question }),
                signal: controller.signal
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || "L'assistente non è disponibile al momento.");
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (line.trim()) handleEvent(JSON.parse(line), turn, state);
                }
            }
            if (!state.done) throw new Error('Risposta interrotta. Riprova.');
        } catch (err) {
            turn.answer.classList.add('assistant-answer-muted');
            turn.answer.textContent = err.name === 'AbortError' ? 'Risposta interrotta.' : err.message;
        } finally {
            stopTimer(turn.status);
            controller = null;
            setBusy(false);
            scrollToEnd();
        }
    }

    async function loadIndexInfo() {
        try {
            const res = await fetch('/api/assistant/status', { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error();
            const data = await res.json();
            footer.textContent = `${data.emails.toLocaleString('it-IT')} email indicizzate. Risposte generate in locale: controlla sempre le fonti.`;
        } catch (e) {
            footer.textContent = 'Assistente non raggiungibile.';
        }
    }

    function setOpen(open) {
        panel.classList.toggle('open', open);
        panel.setAttribute('aria-hidden', String(!open));
        toggle.setAttribute('aria-expanded', String(open));
        if (open) {
            loadIndexInfo();
            input.focus();
        } else {
            toggle.focus();
        }
    }

    // Il pulsante compare solo se il servizio risponde: con l'assistente spento l'app resta com'era.
    fetch('/api/assistant/status', { headers: { Accept: 'application/json' } })
        .then((res) => { if (res.ok) toggle.classList.remove('d-none'); })
        .catch(() => {});

    toggle.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
    closeBtn.addEventListener('click', () => setOpen(false));
    panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setOpen(false);
    });
    stopBtn.addEventListener('click', () => controller && controller.abort());
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const question = input.value.trim();
        if (!question || controller) return;
        input.value = '';
        ask(question);
    });
})();
