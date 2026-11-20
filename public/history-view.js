// The History tab: the versions of the open file (or of its folder, or of everything), a word diff of a version
// against the editor's text or against the version before it, and restoring a version's text into the editor, where
// Ctrl/Cmd+Z undoes it. The server records versions on every Save (history.js); this side only reads them.
(function () {
    const PAGE = 50;
    const MAX_ROWS = 3000;
    const CACHED_TEXTS = 30;
    const REASONS = { external: 'outside changes', first: 'first version' };
    const STATUS_LETTERS = { A: 'added', M: 'changed', D: 'deleted' };
    const OPENABLE = /\.(tex|bib|sty|cls|bst|txt|md)$/i; // what the editor can open (EDITABLE_EXTS in server.js)

    async function getJSON(url) {
        const response = await fetch(url);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
        return data;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function dayLabel(date) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const day = new Date(date);
        day.setHours(0, 0, 0, 0);
        const days = Math.round((today - day) / 86400000);
        if (days === 0) return 'Today';
        if (days === 1) return 'Yesterday';
        return date.toLocaleDateString(undefined, {
            weekday: 'short', day: 'numeric', month: 'short',
            year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric'
        });
    }

    const timeLabel = (date) => date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    function debounce(fn, ms) {
        let timer;
        return () => {
            clearTimeout(timer);
            timer = setTimeout(fn, ms);
        };
    }

    // els: { list, detail, status, scope, refresh }. hooks: current() -> { path, text } for a workspace file,
    // { scratch: true } for a browser-storage file, or null; restore(text) puts text into the editor; open(path)
    // opens a workspace file and resolves whether it could.
    function create(els, hooks) {
        let scope = 'file';
        try {
            scope = localStorage.getItem('historyScope') || 'file';
        } catch { /* a convenience only */ }
        const view = {
            visible: false,
            scope: ['file', 'folder', 'all'].includes(scope) ? scope : 'file',
            versions: [],
            more: false,
            selected: null,
            compare: 'editor', // 'editor': the version against the editor's text; 'previous': against the version before it
            listToken: 0,
            detailToken: 0,
            note: '', // shown above the diff (after a restore) until another version, mode or file is chosen
            recheck: null
        };
        const texts = new Map(); // `${version}:${path}` -> /api/history/file answer

        els.scope.value = view.scope;
        els.scope.addEventListener('change', () => {
            view.scope = els.scope.value;
            try { localStorage.setItem('historyScope', view.scope); } catch { /* a convenience only */ }
            load();
        });
        els.refresh.addEventListener('click', () => load());

        // What the list covers: a path ('' = everything), or null when there is nothing to show.
        function scopePath() {
            if (view.scope === 'all') return '';
            const file = hooks.current();
            if (!file || !file.path) return null;
            if (view.scope === 'folder') return file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
            return file.path;
        }

        async function fileAt(version, path) {
            const key = `${version}:${path}`;
            if (texts.has(key)) return texts.get(key);
            const data = await getJSON('/api/history/file?' + new URLSearchParams({ path, version }));
            texts.set(key, data);
            if (texts.size > CACHED_TEXTS) texts.delete(texts.keys().next().value);
            return data;
        }

        async function loadStatus() {
            clearTimeout(view.recheck);
            try {
                const info = await getJSON('/api/history/status');
                if (!info.enabled) {
                    showStatus(`History is off: ${info.reason}`, 'warn');
                } else if (info.error) {
                    showStatus(info.error, 'error');
                } else {
                    showStatus(`${plural(info.versions, 'version')} · kept in ${info.dir}${info.busy ? ' · recording…' : ''}`);
                }
                // A version still being recorded (a large first version, say): look again shortly.
                if (info.busy && view.visible) view.recheck = setTimeout(load, 2000);
            } catch (error) {
                showStatus(`History: ${error.message}`, 'error');
            }
        }

        function showStatus(text, kind = '') {
            els.status.textContent = text;
            els.status.className = 'history-status' + (kind ? ' ' + kind : '');
        }

        async function load({ append = false } = {}) {
            const token = ++view.listToken;
            const target = scopePath();
            if (!append) view.note = '';
            loadStatus();
            if (target === null) {
                view.versions = [];
                view.more = false;
                const file = hooks.current();
                renderList(file && file.scratch
                    ? 'This file lives in browser storage, so it has no history. Save it into the workspace folder to start one.'
                    : 'Open a file from the workspace to see its versions, or choose Everything.');
                renderDetail();
                return;
            }
            try {
                const params = new URLSearchParams({ path: target, limit: PAGE });
                if (append && view.versions.length) params.set('before', view.versions[view.versions.length - 1].id);
                const data = await getJSON('/api/history/log?' + params);
                if (token !== view.listToken) return;
                view.versions = append ? view.versions.concat(data.versions) : data.versions;
                view.more = data.more;
                if (!view.versions.some((v) => v.id === view.selected)) view.selected = view.versions.length ? view.versions[0].id : null;
                renderList(view.versions.length ? '' : 'No versions yet. Each Save of this file records one.');
                if (!append) renderDetail();
            } catch (error) {
                if (token !== view.listToken) return;
                view.versions = [];
                renderList(error.message);
                renderDetail();
            }
        }

        function renderList(message) {
            els.list.replaceChildren();
            if (message) {
                els.list.append(el('div', 'history-empty', message));
                return;
            }
            let day = '';
            for (const version of view.versions) {
                const when = new Date(version.time);
                const label = dayLabel(when);
                if (label !== day) {
                    day = label;
                    els.list.append(el('div', 'history-day', label));
                }
                const row = el('button', 'history-row' + (version.id === view.selected ? ' selected' : ''));
                row.type = 'button';
                row.dataset.id = version.id;
                row.append(el('span', 'history-time', timeLabel(when)), el('span', 'history-subject', version.subject));
                if (REASONS[version.reason]) row.append(el('span', 'history-badge', REASONS[version.reason]));
                if (version.fileCount > 1) row.append(el('span', 'history-files', plural(version.fileCount, 'file')));
                row.title = version.files.map((f) => `${STATUS_LETTERS[f.status] || f.status}: ${f.path}`).join('\n')
                    + (version.fileCount > version.files.length ? `\n… and ${version.fileCount - version.files.length} more` : '');
                row.addEventListener('click', () => select(version.id));
                row.addEventListener('keydown', (e) => {
                    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
                    if (!step) return;
                    e.preventDefault();
                    const i = view.versions.findIndex((v) => v.id === view.selected) + step;
                    if (view.versions[i]) select(view.versions[i].id, true);
                });
                els.list.append(row);
            }
            if (view.more) {
                const older = el('button', 'history-more', 'Older versions…');
                older.type = 'button';
                older.addEventListener('click', () => load({ append: true }));
                els.list.append(older);
            }
        }

        function select(id, focus = false) {
            view.selected = id;
            view.note = '';
            for (const row of els.list.querySelectorAll('.history-row')) {
                const on = row.dataset.id === id;
                row.classList.toggle('selected', on);
                if (on && focus) {
                    row.focus();
                    row.scrollIntoView({ block: 'nearest' });
                }
            }
            renderDetail();
        }

        function fileChips(version, file) {
            if (version.fileCount <= 1 && file && file.path && version.files.some((f) => f.path === file.path)) return null;
            const box = el('div', 'history-changed');
            box.append(el('span', 'history-changed-label', 'Changed: '));
            for (const change of version.files) {
                const name = change.path;
                const chip = el('button', 'history-chip ' + (STATUS_LETTERS[change.status] || ''), name);
                chip.type = 'button';
                chip.title = `${STATUS_LETTERS[change.status] || change.status} in this version`;
                chip.disabled = change.status === 'D' || !OPENABLE.test(name) || (file && file.path === name);
                chip.addEventListener('click', async () => {
                    if (!(await hooks.open(name))) showStatus(`Could not open ${name}; it may have been moved or deleted since.`, 'error');
                });
                box.append(chip);
            }
            if (version.fileCount > version.files.length) box.append(el('span', 'history-more-files', ` and ${version.fileCount - version.files.length} more`));
            return box;
        }

        async function renderDetail() {
            const token = ++view.detailToken;
            const version = view.versions.find((v) => v.id === view.selected);
            const file = hooks.current();
            els.detail.replaceChildren();
            if (!version) return;

            const when = new Date(version.time);
            const head = el('div', 'history-head');
            head.append(el('div', 'history-title', version.subject),
                el('div', 'history-when', `${dayLabel(when)}, ${timeLabel(when)} · ${version.id.slice(0, 8)}`));
            els.detail.append(head);
            const chips = fileChips(version, file);
            if (chips) els.detail.append(chips);
            if (!file || !file.path) {
                els.detail.append(el('div', 'history-empty', 'Open a file from the workspace to compare it with this version.'));
                return;
            }

            const controls = el('div', 'history-controls');
            const modes = el('div', 'history-modes');
            for (const [mode, label, tip] of [
                ['editor', 'Since then', 'What has changed in the editor since this version'],
                ['previous', 'In this version', 'What this version changed']
            ]) {
                const button = el('button', 'history-mode' + (view.compare === mode ? ' active' : ''), label);
                button.type = 'button';
                button.title = tip;
                button.setAttribute('aria-pressed', String(view.compare === mode));
                button.addEventListener('click', () => {
                    view.compare = mode;
                    view.note = '';
                    renderDetail();
                });
                modes.append(button);
            }
            const restore = el('button', 'btn-secondary btn-small history-restore', 'Restore this version');
            restore.type = 'button';
            restore.disabled = true;
            restore.title = `Put ${file.path} as it was in this version into the editor (undo with Ctrl/Cmd+Z; Save to keep it)`;
            controls.append(modes, restore);
            const summary = el('div', 'history-summary', 'Loading…');
            const body = el('div', 'diff-view');
            els.detail.append(controls, summary, body);
            if (view.note) summary.before(el('div', 'history-note', view.note));

            let then;
            let before;
            try {
                then = await fileAt(version.id, file.path);
                before = view.compare === 'editor' ? { content: file.text }
                    : version.parent ? await fileAt(version.parent, file.path) : { missing: true };
            } catch (error) {
                if (token === view.detailToken) summary.textContent = error.message;
                return;
            }
            if (token !== view.detailToken) return;

            if (then.binary) {
                summary.textContent = `${file.path} was not a text file in this version (${then.size} bytes).`;
                return;
            }
            if (!then.missing && then.content !== file.text) {
                restore.disabled = false;
                restore.addEventListener('click', () => {
                    view.note = hooks.restore(then.content)
                        ? `Restored ${file.path} from ${dayLabel(when)}, ${timeLabel(when)} into the editor. Ctrl/Cmd+Z undoes it; Save keeps it.`
                        : 'The editor already has this text.';
                    renderDetail();
                });
            }
            let oldText;
            let newText;
            if (view.compare === 'editor') {
                if (then.missing) {
                    summary.textContent = `${file.path} is not in this version.`;
                    return;
                }
                [oldText, newText] = [then.content, file.text];
            } else {
                if (then.missing) {
                    summary.textContent = `${file.path} was deleted or not yet created in this version.`;
                    return;
                }
                [oldText, newText] = [before.missing || before.binary ? '' : before.content, then.content];
            }
            const result = LatexDiff.diff(oldText, newText);
            if (result.identical) {
                summary.textContent = view.compare === 'editor' ? 'The editor has exactly this version.' : 'This version did not change the file.';
                return;
            }
            const counts = [result.added && `+${plural(result.added, 'word')}`, result.removed && `−${plural(result.removed, 'word')}`].filter(Boolean);
            summary.textContent = (view.compare === 'editor' ? 'Since this version: ' : 'This version: ')
                + (counts.length ? counts.join(', ') : 'spacing and punctuation only')
                + (view.compare === 'previous' && before.missing ? ' (new file)' : '');
            renderRows(body, result.rows);
        }

        function renderRows(container, rows) {
            const fragment = document.createDocumentFragment();
            for (const row of rows.slice(0, MAX_ROWS)) {
                const line = el('div', 'diff-row ' + row.type);
                if (row.type === 'skip') {
                    line.textContent = `⋯ ${plural(row.count, 'unchanged line')}`;
                    fragment.append(line);
                    continue;
                }
                line.append(el('span', 'diff-ln', row.line ? String(row.line) : ''));
                const text = el('span', 'diff-text');
                for (const part of row.parts) {
                    if (part.op === '=') text.append(part.text);
                    else text.append(el(part.op === '-' ? 'del' : 'ins', '', part.text));
                }
                line.append(text);
                fragment.append(line);
            }
            if (rows.length > MAX_ROWS) fragment.append(el('div', 'diff-row skip', `… ${plural(rows.length - MAX_ROWS, 'more line')} not shown`));
            container.replaceChildren(fragment);
        }

        const editorChanged = debounce(() => {
            if (view.visible && view.compare === 'editor') renderDetail();
        }, 400);

        return {
            show() {
                view.visible = true;
                load();
            },
            hide() {
                view.visible = false;
                clearTimeout(view.recheck);
            },
            // Another file was opened (or the open one closed).
            fileChanged() {
                if (!view.visible) return;
                view.note = '';
                if (view.scope === 'all') renderDetail();
                else load();
            },
            editorChanged,
            // A file was saved: the server records a version, and the list waits for it.
            saved() {
                if (view.visible) load();
            }
        };
    }

    window.HistoryView = { create };
})();
