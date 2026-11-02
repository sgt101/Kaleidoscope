// Storage helpers: localStorage can be unavailable, full or corrupt, and none of that should stop the app.
function loadJSON(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

// State management
const state = {
    files: loadJSON('latexFiles', {}),
    currentFile: (() => { try { return localStorage.getItem('currentFile'); } catch { return null; } })(),
    chatHistory: loadJSON('chatHistory', []),
    // Keys of workspace files ("ws:<relative path>") with edits not yet saved to disk.
    dirty: new Set(loadJSON('dirtyFiles', [])),
    browsePath: ''
};

const WS_PREFIX = 'ws:';
const isWorkspaceKey = (key) => typeof key === 'string' && key.startsWith(WS_PREFIX);
const displayName = (key) => (isWorkspaceKey(key) ? key.slice(WS_PREFIX.length) : key);
const hasFile = (key) => Object.prototype.hasOwnProperty.call(state.files, key);

// DOM Elements
const editor = document.getElementById('editor');
const currentFileDisplay = document.getElementById('currentFile');
const fileTree = document.getElementById('fileTree');
const compileBtn = document.getElementById('compileBtn');
const newFileBtn = document.getElementById('newFileBtn');
const uploadFileBtn = document.getElementById('uploadFileBtn');
const browseBtn = document.getElementById('browseBtn');
const saveBtn = document.getElementById('saveBtn');
const engineSelect = document.getElementById('engineSelect');
const browseDialog = document.getElementById('browseDialog');
const browseCrumbs = document.getElementById('browseCrumbs');
const browseList = document.getElementById('browseList');
const browseStatus = document.getElementById('browseStatus');
const browseTitle = document.getElementById('browseTitle');
const browseNewName = document.getElementById('browseNewName');
const browseNewBtn = document.getElementById('browseNewBtn');
const browseCloseBtn = document.getElementById('browseCloseBtn');
const fileInput = document.getElementById('fileInput');
const clearPreviewBtn = document.getElementById('clearPreviewBtn');
const editorZoomOut = document.getElementById('editorZoomOut');
const editorZoomIn = document.getElementById('editorZoomIn');
const editorZoomReset = document.getElementById('editorZoomReset');
const pdfZoomOut = document.getElementById('pdfZoomOut');
const pdfZoomIn = document.getElementById('pdfZoomIn');
const pdfZoomReset = document.getElementById('pdfZoomReset');
const pdfPreview = document.getElementById('pdfPreview');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const providerSelect = document.getElementById('providerSelect');
const modelInput = document.getElementById('modelInput');
const modelList = document.getElementById('modelList');
const assistantNote = document.getElementById('assistantStatus');
const fixBtn = document.getElementById('fixBtn');
const rewriteBtn = document.getElementById('rewriteBtn');
const explainBtn = document.getElementById('explainBtn');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    renderFileTree();
    loadChatHistory();
    
    if (state.currentFile && hasFile(state.currentFile)) {
        openFile(state.currentFile);
    } else {
        updateEditorHeader();
    }

    setupEventListeners();
});

// Event Listeners
function setupEventListeners() {
    // The in-memory copy follows every keystroke, so switching files or compiling never sees stale text;
    // only the (comparatively expensive) localStorage write is debounced.
    const saveSoon = debounce(saveState, 500);
    LatexComplete.attach(editor); // before the handler below: an accepted completion is typed text like any other
    editor.addEventListener('input', () => {
        if (state.currentFile) {
            state.files[state.currentFile] = editor.value;
            if (isWorkspaceKey(state.currentFile) && !state.dirty.has(state.currentFile)) {
                state.dirty.add(state.currentFile);
                updateEditorHeader();
                renderFileTree();
            }
            saveSoon();
        }
    });

    // Ctrl/Cmd+S saves a workspace file to disk (and never opens the browser's own "save page" dialog).
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveToDisk();
        }
    });
    saveBtn.addEventListener('click', saveToDisk);

    browseBtn.addEventListener('click', () => openBrowser());
    browseCloseBtn.addEventListener('click', () => browseDialog.close());
    browseDialog.addEventListener('click', (e) => {
        if (e.target === browseDialog) browseDialog.close(); // click on the backdrop
    });
    browseNewBtn.addEventListener('click', createWorkspaceFile);
    browseNewName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') createWorkspaceFile();
    });

    compileBtn.addEventListener('click', compileAndPreview);
    newFileBtn.addEventListener('click', createNewFile);
    uploadFileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileUpload);
    clearPreviewBtn.addEventListener('click', () => {
        currentPdf = null;
        renderToken++;
        pdfPreview.innerHTML = '';
    });
    // Remember the engine choice.
    try { engineSelect.value = localStorage.getItem('engine') || 'auto'; } catch { /* default stays Auto */ }
    engineSelect.addEventListener('change', () => {
        try { localStorage.setItem('engine', engineSelect.value); } catch { /* a convenience only */ }
    });
    loadProviders();
    setupLayout();
    setupZoom();

    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    sendBtn.addEventListener('click', sendMessage);
    stopBtn.addEventListener('click', () => activeRequest && activeRequest.abort());
    fixBtn.addEventListener('click', () => ask('fix'));
    rewriteBtn.addEventListener('click', () => ask('rewrite'));
    explainBtn.addEventListener('click', () => ask('explain'));
    providerSelect.addEventListener('change', () => {
        try { localStorage.setItem('provider', providerSelect.value); } catch { /* a convenience only */ }
        showModel();
        providerNote();
    });
    modelInput.addEventListener('change', () => {
        const provider = selectedProvider();
        if (!provider) return;
        const name = modelInput.value.trim();
        try {
            if (name && name !== provider.model) localStorage.setItem('model:' + provider.id, name);
            else localStorage.removeItem('model:' + provider.id);
        } catch { /* a convenience only */ }
        showModel();
        providerNote();
    });
    // The list shows only names that match what is typed, so empty the box while choosing.
    modelInput.addEventListener('focus', () => { modelInput.placeholder = modelInput.value || 'model'; modelInput.value = ''; });
    modelInput.addEventListener('blur', () => { if (!modelInput.value.trim()) showModel(); });
    // The selection decides whether "Rewrite selection" is available.
    for (const type of ['select', 'keyup', 'mouseup', 'input']) editor.addEventListener(type, updateTaskButtons);
    // A model server may have been started since the page loaded.
    window.addEventListener('focus', loadProviders);
    updateTaskButtons();
}

// File Management
function renderFileTree() {
    fileTree.innerHTML = '';
    for (const filename in state.files) {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item' + (state.currentFile === filename ? ' active' : '');
        const workspace = isWorkspaceKey(filename);
        if (workspace) fileItem.classList.add('on-disk');
        fileItem.title = workspace ? `${displayName(filename)} (on disk)` : `${filename} (browser storage)`;

        const label = document.createElement('span');
        label.className = 'file-label';
        label.textContent = displayName(filename);
        fileItem.appendChild(label);
        if (state.dirty.has(filename)) {
            const dot = document.createElement('span');
            dot.className = 'dirty-dot';
            dot.textContent = '●';
            dot.title = 'Unsaved changes';
            fileItem.appendChild(dot);
        }
        fileItem.addEventListener('click', () => openFile(filename));

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-icon';
        deleteBtn.textContent = '✕';
        deleteBtn.title = workspace ? 'Close (the file on disk is kept)' : 'Delete';
        deleteBtn.style.marginLeft = state.dirty.has(filename) ? '0' : 'auto';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteFile(filename);
        });
        
        fileItem.appendChild(deleteBtn);
        fileTree.appendChild(fileItem);
    }
}

function openFile(filename) {
    state.currentFile = filename;
    editor.value = state.files[filename];
    updateEditorHeader();
    renderFileTree();
    saveState();
}

// Shows the open file's name (with its location and unsaved state) and enables Save for files on disk.
function updateEditorHeader() {
    const key = state.currentFile;
    if (!key || !hasFile(key)) {
        currentFileDisplay.textContent = 'No file selected';
        saveBtn.disabled = true;
        saveBtn.title = 'Nothing to save';
        updateTaskButtons();
        return;
    }
    const workspace = isWorkspaceKey(key);
    currentFileDisplay.textContent = displayName(key) + (state.dirty.has(key) ? ' ●' : '') + (workspace ? '' : '  (browser storage)');
    currentFileDisplay.title = displayName(key);
    // Files on disk save in place once changed. Browser-storage files always offer "Save", which asks where in the
    // workspace folder to put them.
    saveBtn.disabled = workspace && !state.dirty.has(key);
    saveBtn.title = workspace ? 'Save to disk (Ctrl/Cmd+S)' : 'Save into the workspace folder (Ctrl/Cmd+S). Until then this file lives only in this browser.';
    updateTaskButtons();
}

function defaultTemplate(name) {
    return `\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\n\\title{${name.replace(/\.tex$/, '')}}\n\\author{}\n\\date{}\n\n\\begin{document}\n\n\\maketitle\n\n\\section{Introduction}\n\nYour content here.\n\n\\end{document}`;
}

function createNewFile() {
    const name = prompt('Enter filename (e.g., document.tex):');
    if (!name) return;
    if (isWorkspaceKey(name)) {
        alert(`Names starting with "${WS_PREFIX}" are reserved for files on disk.`);
        return;
    }
    if (hasFile(name)) {
        alert('File already exists!');
        return;
    }
    state.files[name] = defaultTemplate(name);
    openFile(name);
}

function deleteFile(filename) {
    const workspace = isWorkspaceKey(filename);
    const unsaved = state.dirty.has(filename);
    const question = workspace
        ? `Close ${displayName(filename)}?${unsaved ? ' Your unsaved changes will be lost.' : ' The file on disk is kept.'}`
        : `Delete ${filename}?`;
    if (confirm(question)) {
        delete state.files[filename];
        state.dirty.delete(filename);
        if (state.currentFile === filename) {
            state.currentFile = null;
            editor.value = '';
        }
        updateEditorHeader();
        renderFileTree();
        saveState();
    }
}

// ---- Workspace file browser ----
async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}

// Save mode (saveFor = key of a browser-storage file): the dialog picks a folder and a name instead of a file to open.
let saveFor = null;

function openBrowser(key = null) {
    saveFor = key;
    browseTitle.textContent = key ? `Save “${key}” to the workspace` : 'Open file';
    browseNewBtn.textContent = key ? 'Save here' : 'Create';
    browseNewName.placeholder = key ? 'File name' : 'New file in this folder (e.g. notes.tex)';
    browseNewName.value = key || '';
    if (!browseDialog.open) browseDialog.showModal();
    browseTo(state.browsePath);
}

async function browseTo(dirPath) {
    browseStatus.textContent = 'Loading…';
    browseStatus.className = 'browse-status';
    try {
        const data = await api('/api/fs/list?path=' + encodeURIComponent(dirPath));
        state.browsePath = data.path;
        renderBrowser(data);
        browseStatus.textContent = '';
    } catch (error) {
        // A remembered folder may have gone away; fall back to the top once before reporting.
        if (dirPath) return browseTo('');
        browseList.innerHTML = '';
        browseStatus.textContent = error.message;
        browseStatus.className = 'browse-status error';
    }
}

function renderBrowser({ path: dirPath, root, entries }) {
    // Breadcrumbs: root / folder / subfolder, each one a button that jumps there.
    browseCrumbs.innerHTML = '';
    const parts = dirPath ? dirPath.split('/') : [];
    const crumbs = [{ label: root, path: '' }, ...parts.map((part, i) => ({ label: part, path: parts.slice(0, i + 1).join('/') }))];
    crumbs.forEach((crumb, i) => {
        const last = i === crumbs.length - 1;
        const button = document.createElement('button');
        button.className = 'crumb' + (last ? ' current' : '');
        button.textContent = crumb.label;
        button.disabled = last;
        button.addEventListener('click', () => browseTo(crumb.path));
        browseCrumbs.appendChild(button);
        if (!last) browseCrumbs.append(' / ');
    });

    browseList.innerHTML = '';
    if (dirPath) {
        browseList.appendChild(browseRow('⬆', '..', 'Parent folder', () => browseTo(parts.slice(0, -1).join('/'))));
    }
    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'browse-empty';
        empty.textContent = 'This folder is empty.';
        browseList.appendChild(empty);
    }
    for (const entry of entries) {
        const rel = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        if (entry.type === 'dir') {
            browseList.appendChild(browseRow('📁', entry.name, '', () => browseTo(rel)));
        } else {
            // Save mode: clicking a file offers its name (to replace it); otherwise open it.
            const onClick = saveFor ? () => { browseNewName.value = entry.name; browseNewName.focus(); } : () => openWorkspaceFile(rel);
            const row = browseRow('📄', entry.name, formatSize(entry.size), onClick, !entry.editable);
            if (state.currentFile === WS_PREFIX + rel) row.classList.add('active');
            browseList.appendChild(row);
        }
    }
    // Keyboard: start on the first item, so Enter/arrow keys work right after the dialog opens.
    const first = browseList.querySelector('button:not(:disabled)');
    if (first) first.focus();
}

function browseRow(icon, name, meta, onClick, disabled = false) {
    const row = document.createElement('button');
    row.className = 'browse-row';
    row.disabled = disabled;
    if (disabled) row.title = 'Not a text file this editor can open';
    for (const [cls, text] of [['icon', icon], ['name', name], ['meta', meta]]) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        row.appendChild(span);
    }
    row.addEventListener('click', onClick);
    row.addEventListener('keydown', (e) => {
        const items = [...browseList.querySelectorAll('button:not(:disabled)')];
        const i = items.indexOf(row);
        if (e.key === 'ArrowDown' && items[i + 1]) { e.preventDefault(); items[i + 1].focus(); }
        if (e.key === 'ArrowUp' && items[i - 1]) { e.preventDefault(); items[i - 1].focus(); }
    });
    return row;
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function openWorkspaceFile(rel) {
    const key = WS_PREFIX + rel;
    try {
        // Already open: keep the copy in the editor (it may hold unsaved edits) instead of reloading from disk.
        if (!hasFile(key)) {
            const data = await api('/api/fs/file?path=' + encodeURIComponent(rel));
            state.files[key] = data.content;
        }
        browseDialog.close();
        openFile(key);
        editor.focus();
    } catch (error) {
        browseStatus.textContent = error.message;
        browseStatus.className = 'browse-status error';
    }
}

async function createWorkspaceFile() {
    const name = browseNewName.value.trim();
    if (!name) return;
    if (/[\\/]/.test(name)) {
        browseStatus.textContent = 'Enter a file name only; browse into the folder first.';
        browseStatus.className = 'browse-status error';
        return;
    }
    const fileName = /\.[A-Za-z0-9]+$/.test(name) ? name : name + '.tex';
    const rel = state.browsePath ? `${state.browsePath}/${fileName}` : fileName;
    const moving = saveFor; // a browser-storage file being saved, rather than a new empty file
    try {
        const existing = await api('/api/fs/list?path=' + encodeURIComponent(state.browsePath));
        const exists = existing.entries.some((e) => e.name === fileName);
        if (exists && !moving) throw new Error(`${fileName} already exists in this folder`);
        if (exists && !confirm(`Replace ${rel} on disk with this file?`)) return;
        const content = moving
            ? (moving === state.currentFile ? editor.value : state.files[moving])
            : (fileName.endsWith('.tex') ? defaultTemplate(fileName) : '');
        await api('/api/fs/file', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: rel, content })
        });
        const key = WS_PREFIX + rel;
        if (moving) {
            // The file now lives on disk: swap the browser-storage copy for the workspace one.
            delete state.files[moving];
            state.dirty.delete(moving);
        }
        state.files[key] = content;
        state.dirty.delete(key);
        browseDialog.close();
        openFile(key);
        editor.focus();
    } catch (error) {
        browseStatus.textContent = error.message;
        browseStatus.className = 'browse-status error';
    }
}

async function saveToDisk() {
    const key = state.currentFile;
    if (!key || !hasFile(key)) return;
    if (!isWorkspaceKey(key)) {
        openBrowser(key);
        return;
    }
    if (!state.dirty.has(key)) return;
    saveBtn.disabled = true;
    const sent = editor.value;
    try {
        await api('/api/fs/file', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: displayName(key), content: sent })
        });
        // Typing during the request leaves the file dirty: what is on disk is already out of date.
        if (state.files[key] === sent) state.dirty.delete(key);
        saveState();
        renderFileTree();
    } catch (error) {
        alert(`Could not save ${displayName(key)}: ${error.message}`);
    }
    updateEditorHeader();
}

function handleFileUpload(e) {
    const files = e.target.files;
    for (let file of files) {
        const reader = new FileReader();
        reader.onload = (event) => {
            let filename = file.name;
            let counter = 1;
            while (state.files[filename]) {
                const ext = filename.split('.').pop();
                const base = filename.replace('.' + ext, '');
                filename = `${base}_${counter}.${ext}`;
                counter++;
            }
            state.files[filename] = event.target.result;
            openFile(filename);
        };
        reader.readAsText(file);
    }
    e.target.value = '';
}

// LaTeX Compilation
async function compileAndPreview() {
    if (!state.currentFile) {
        alert('Please select or create a file first');
        return;
    }

    const compiledKey = state.currentFile;
    compileBtn.disabled = true;
    compileBtn.textContent = 'Compiling...';
    currentPdf = null;
    renderToken++;
    pdfPreview.innerHTML = '<div class="error">Compiling...</div>';

    try {
        // Compile what is in the editor right now, not the last saved copy.
        const pdfData = await compileLatex(editor.value);
        delete compileErrors[compiledKey];
        pdfPreview.innerHTML = '';
        const engineName = engineSelect.querySelector(`option[value="${pdfData.engine}"]`)?.textContent;
        const message = [engineName && `Compiled with ${engineName}`, pdfData.notes].filter(Boolean).join(' · ');
        if (message) {
            const note = document.createElement('div');
            note.className = 'note' + (pdfData.notes ? ' warn' : '');
            note.textContent = message;
            pdfPreview.appendChild(note);
        }
        await displayPDF(pdfData);
    } catch (error) {
        compileErrors[compiledKey] = error.message;
        pdfPreview.innerHTML = `<div class="error">Compilation Error:<br>${escapeHtml(error.message)}</div>`;
    } finally {
        compileBtn.disabled = false;
        compileBtn.textContent = 'Compile PDF';
        updateTaskButtons(); // "Fix error" follows the outcome
    }
}

async function compileLatex(texContent) {
    try {
        // A file opened from disk is compiled together with the rest of its folder (\input, images, .bib),
        // using the unsaved text of any other open files in that folder.
        const body = { texContent, engine: engineSelect.value };
        if (isWorkspaceKey(state.currentFile)) {
            body.path = displayName(state.currentFile);
            body.overrides = {};
            for (const key of state.dirty) {
                if (key !== state.currentFile && hasFile(key)) body.overrides[displayName(key)] = state.files[key];
            }
        }
        const response = await fetch('/api/compile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.details || error.error || `Compilation failed (${response.status})`);
        }

        // Response is binary PDF data
        const pdfBlob = await response.blob();
        const notes = response.headers.get('X-Compile-Notes');
        return { type: 'pdf', blob: pdfBlob, engine: response.headers.get('X-Compile-Engine'),
            notes: notes ? decodeURIComponent(notes) : '' };
    } catch (error) {
        console.error('Compilation error:', error);
        throw error;
    }
}

// The last compiled PDF stays loaded so zooming or resizing the pane can re-render it without recompiling.
// The last compile error of each open file, so the assistant can be told why a compile failed.
const compileErrors = {};

let currentPdf = null;
let renderToken = 0;
let lastRenderWidth = 0;

async function displayPDF(pdfData) {
    if (pdfData.type === 'pdf') {
        if (!pdfjsLib) {
            throw new Error('PDF.js did not load (check your connection to cdnjs.cloudflare.com)');
        }
        currentPdf = await pdfjsLib.getDocument({ data: await pdfData.blob.arrayBuffer() }).promise;
        await renderPDF();
    }
}

// Draws every page at (pane width x zoom). 100% means a page exactly fills the pane's width. Pages are drawn
// off-screen and swapped in together, and a newer render (another zoom step, a resize) cancels an older one.
async function renderPDF() {
    if (!currentPdf) return;
    const token = ++renderToken;
    const style = getComputedStyle(pdfPreview);
    const available = pdfPreview.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (available <= 0) return; // pane hidden
    lastRenderWidth = pdfPreview.clientWidth;

    const ratio = window.devicePixelRatio || 1;
    const canvases = [];
    for (let pageNum = 1; pageNum <= currentPdf.numPages; pageNum++) {
        const page = await currentPdf.getPage(pageNum);
        if (token !== renderToken) return;
        const fit = available / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale: fit * zoom.pdf * ratio });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${viewport.width / ratio}px`;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        if (token !== renderToken) return;
        canvases.push(canvas);
    }
    pdfPreview.querySelectorAll('canvas').forEach((old) => old.remove());
    pdfPreview.append(...canvases);
}

// Chat Assistant
// A question goes to the provider chosen above the chat. The reply streams in as text; edit blocks in it become
// cards showing the change as a diff, and nothing touches the editor until Accept is pressed.
let providers = [];
let activeRequest = null; // AbortController of the question being answered

async function loadProviders() {
    try {
        const info = await (await fetch('/api/assistant')).json();
        providers = info.providers || [];
        const current = providerSelect.value;
        providerSelect.replaceChildren(...providers.map((p) => {
            const option = document.createElement('option');
            option.value = p.id;
            option.textContent = p.label + (p.ready ? '' : ' (not ready)');
            return option;
        }));
        let saved = '';
        try { saved = localStorage.getItem('provider') || ''; } catch { /* a convenience only */ }
        const wanted = [current, saved, info.default].find((id) => id && providers.some((p) => p.id === id));
        if (wanted) providerSelect.value = wanted;
        showModel();
        providerNote(info.error);
    } catch {
        assistantNote.textContent = '';
    }
}

const selectedProvider = () => providers.find((p) => p.id === providerSelect.value);

// The model to ask: the one typed or picked for this provider, otherwise its configured default.
function chosenModel(provider = selectedProvider()) {
    if (!provider || provider.kind === 'trifle') return '';
    let saved = '';
    try { saved = localStorage.getItem('model:' + provider.id) || ''; } catch { /* a convenience only */ }
    return saved || provider.model;
}

// Fill the model box and its list for the selected provider. Trifle chooses its own model, so the box is hidden.
function showModel() {
    const provider = selectedProvider();
    modelInput.disabled = !provider || provider.kind === 'trifle';
    if (document.activeElement !== modelInput) { // not while the user is choosing
        modelInput.value = chosenModel(provider);
        modelInput.placeholder = 'model';
    }
    const names = provider ? [...new Set([provider.model, ...(provider.models || [])].filter(Boolean))] : [];
    modelList.replaceChildren(...names.map((name) => {
        const option = document.createElement('option');
        option.value = name;
        return option;
    }));
}

function providerNote(error = '') {
    const provider = selectedProvider();
    let text;
    let kind = 'warn';
    if (!provider) {
        text = error || 'No model provider is configured (see README, "The assistant").';
    } else if (!provider.ready) {
        text = `${provider.label} is not ready: ${provider.detail}`;
    } else if (provider.kind === 'trifle') {
        text = 'Trifle (its own model and tools; the open file is sent to it)';
        kind = 'ok';
    } else if (provider.local) {
        text = 'local: the open file stays on this machine';
        kind = 'ok';
    } else {
        text = `sends the open file to ${provider.host}`;
        kind = 'remote';
    }
    assistantNote.textContent = text;
    assistantNote.className = 'assistant-status ' + kind;
}

// Which task buttons make sense right now.
function updateTaskButtons() {
    const open = Boolean(state.currentFile && hasFile(state.currentFile));
    const selected = open && editor.selectionEnd > editor.selectionStart;
    const busy = Boolean(activeRequest);
    fixBtn.disabled = busy || !open || !compileErrors[state.currentFile];
    rewriteBtn.disabled = busy || !selected;
    explainBtn.disabled = busy || !open;
}

function setBusy(busy) {
    sendBtn.hidden = busy;
    stopBtn.hidden = !busy;
    updateTaskButtons();
}

async function* readEvents(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try { yield JSON.parse(line); } catch { /* not an event */ }
        }
    }
}

const TASK_LABELS = { fix: 'Fix the compile error', rewrite: 'Rewrite the selection', explain: 'Explain' };

async function ask(task) {
    if (activeRequest) return;
    const typed = chatInput.value.trim();
    if (task === 'ask' && !typed) return;
    const key = state.currentFile;
    if (!key || !hasFile(key)) {
        addChatMessage('Open a file first: the assistant works on the file in the editor.', 'error');
        return;
    }
    const provider = selectedProvider();
    if (!provider) {
        addChatMessage('No model provider is configured (see README, "The assistant").', 'error');
        return;
    }
    if (task === 'rewrite' && !typed) {
        assistantNote.textContent = 'Type how the selection should change in the box below, then press Rewrite selection.';
        assistantNote.className = 'assistant-status warn';
        chatInput.focus();
        return;
    }

    const shown = task === 'ask' ? typed : (typed ? `${TASK_LABELS[task]}: ${typed}` : TASK_LABELS[task]);
    addChatMessage(shown, 'user');
    chatInput.value = '';
    const history = state.chatHistory.slice();
    state.chatHistory.push({ role: 'user', content: shown });
    saveState();

    const reply = addChatMessage(`Waiting for ${provider.label}…`, 'assistant pending');
    const controller = new AbortController();
    activeRequest = controller;
    setBusy(true);

    let text = '';
    let final = null;
    const show = () => {
        reply.className = 'chat-message assistant';
        reply.textContent = text;
        chatMessages.scrollTop = chatMessages.scrollHeight;
    };
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: provider.id, model: chosenModel(provider), task, message: typed, history, ...editorContext() }),
            signal: controller.signal
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.details || error.error || `Request failed (${response.status})`);
        }
        for await (const event of readEvents(response)) {
            if (event.type === 'text') { text += event.text; show(); }
            else if (event.type === 'reset') { text = event.text; if (text) show(); else reply.textContent = 'Asking again…'; }
            else if (event.type === 'retry') { assistantNote.textContent = `Asking again: ${event.reason}.`; assistantNote.className = 'assistant-status warn'; }
            else if (event.type === 'error') throw new Error(event.message);
            else if (event.type === 'done') final = event;
        }
        if (!final) throw new Error('The connection closed before the answer was complete.');
        renderAssistant(reply, final.text, { key, interactive: true, failures: final.failures, truncated: final.truncated });
        state.chatHistory.push({ role: 'assistant', content: final.text });
        saveState();
    } catch (error) {
        if (controller.signal.aborted) {
            reply.className = 'chat-message assistant stopped';
            reply.textContent = (text ? text + '\n\n' : '') + '(stopped)';
        } else {
            reply.className = 'chat-message error';
            reply.textContent = 'Error: ' + (error.message.includes('Failed to fetch')
                ? 'Cannot reach the editor server. Is it still running?' : error.message);
        }
    } finally {
        activeRequest = null;
        setBusy(false);
        providerNote();
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

const sendMessage = () => ask('ask');

// What the assistant is shown of the editor: the open file, where the selection and the cursor are, and why the last
// compile failed.
function editorContext() {
    const key = state.currentFile;
    if (!key || !hasFile(key)) return {};
    return {
        texContent: editor.value,
        fileName: displayName(key),
        selStart: editor.selectionStart,
        selEnd: editor.selectionEnd,
        cursor: editor.selectionStart,
        compileError: compileErrors[key] || ''
    };
}

function addChatMessage(content, role) {
    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${role}`;
    messageEl.textContent = content;
    chatMessages.appendChild(messageEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return messageEl;
}

// Fill `el` with an assistant reply: its text, and a card for each edit block.
function renderAssistant(el, text, { key = null, interactive = false, failures = [], truncated = false } = {}) {
    el.className = 'chat-message assistant';
    el.replaceChildren();
    const cards = [];
    for (const segment of LatexEdits.parse(text).segments) {
        if (segment.type === 'text') {
            const part = document.createElement('div');
            part.className = 'chat-text';
            part.textContent = segment.text;
            el.append(part);
        } else {
            const failure = failures.find((f) => f.index === cards.length);
            const card = editCard(segment, { key, interactive, problem: failure ? failure.reason : '' });
            cards.push(card);
            el.append(card.element);
        }
    }
    if (truncated) {
        const note = document.createElement('div');
        note.className = 'chat-note';
        note.textContent = 'The answer stopped at the model\'s output limit and may be incomplete.';
        el.append(note);
    }
    const open = cards.filter((card) => card.canAccept);
    if (interactive && open.length > 1) {
        const row = document.createElement('div');
        row.className = 'edit-actions';
        const all = document.createElement('button');
        all.className = 'btn-secondary btn-small';
        all.textContent = `Accept all ${open.length}`;
        all.addEventListener('click', () => {
            for (const card of open) if (!card.accept()) break;
            all.disabled = true;
        });
        row.append(all);
        el.append(row);
    }
    if (!el.childNodes.length) el.textContent = text;
}

function editCard(edit, { key, interactive, problem }) {
    const element = document.createElement('div');
    element.className = 'edit-card';
    const head = document.createElement('div');
    head.className = 'edit-head';
    const title = document.createElement('span');
    title.className = 'edit-title';
    title.textContent = 'Suggested change';
    const status = document.createElement('span');
    status.className = 'edit-status';
    head.append(title, status);

    const diff = document.createElement('pre');
    diff.className = 'edit-diff';
    const { removed, added } = LatexEdits.diffLines(edit.search, edit.replace);
    for (const [lines, sign, cls] of [[removed, '− ', 'del'], [added, '+ ', 'add']]) {
        for (const line of lines) {
            const row = document.createElement('span');
            row.className = cls;
            row.textContent = sign + line;
            diff.append(row);
        }
    }
    if (!removed.length && !added.length) diff.textContent = '(no change)';

    const card = { element, canAccept: false, accept: () => false };
    element.append(head, diff);
    if (!interactive) return card;

    const accept = document.createElement('button');
    accept.className = 'btn-primary btn-small';
    accept.textContent = 'Accept';
    const reject = document.createElement('button');
    reject.className = 'btn-secondary btn-small';
    reject.textContent = 'Reject';
    head.append(accept, reject);

    const finish = (label, cls) => {
        status.textContent = label;
        element.classList.add(cls);
        accept.disabled = reject.disabled = true;
        card.canAccept = false;
    };
    if (problem) {
        status.textContent = `Not applicable: it ${problem}.`;
        element.classList.add('failed');
        accept.disabled = true;
        reject.disabled = true;
        return card;
    }

    card.canAccept = true;
    card.accept = () => {
        if (!card.canAccept) return true;
        if (state.currentFile !== key) {
            status.textContent = `Open ${displayName(key)} to apply this.`;
            return false;
        }
        const failure = applyEdit(edit);
        if (failure) {
            status.textContent = `Cannot apply: it ${LatexEdits.describe(failure)}.`;
            return false;
        }
        finish('Applied. Undo with Ctrl/Cmd+Z.', 'applied');
        return true;
    };
    accept.addEventListener('click', card.accept);
    reject.addEventListener('click', () => finish('Rejected', 'rejected'));
    return card;
}

// Put an edit into the editor through the text field's own undo stack. Returns null, or why it does not fit.
function applyEdit(edit) {
    const where = LatexEdits.locate(editor.value, edit.search);
    if (where.error) return where;
    const before = editor.value;
    const expected = before.slice(0, where.start) + edit.replace + before.slice(where.end);
    editor.focus();
    editor.setSelectionRange(where.start, where.end);
    let done = false;
    try {
        done = edit.replace ? document.execCommand('insertText', false, edit.replace) : document.execCommand('delete');
    } catch { /* no execCommand: use the fallback */ }
    if (!done || editor.value !== expected) {
        editor.value = expected; // loses the native undo, but the text is right
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    editor.setSelectionRange(where.start, where.start + edit.replace.length);
    updateTaskButtons();
    return null;
}

function loadChatHistory() {
    state.chatHistory.forEach((msg) => {
        const el = addChatMessage(msg.content, msg.role);
        if (msg.role === 'assistant') renderAssistant(el, msg.content);
    });
}

// ---- Resizable panes ----
const LAYOUT_DEFAULTS = { sidebar: 250, preview: 400, chat: 260 };
const layout = { ...LAYOUT_DEFAULTS, ...loadJSON('layout', {}) };

function saveJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { /* layout and zoom are conveniences; losing them is harmless */ }
}

// Each splitter says which size it controls, which way dragging grows it, and how far it may go.
function clampLayout(name, value) {
    const container = document.querySelector('.editor-container');
    const previewVisible = getComputedStyle(previewPane).display !== 'none';
    const room = container.clientWidth - (previewVisible ? 2 : 1) * 5 - 200; // keep at least 200px for the editor
    const limits = {
        sidebar: [120, Math.max(120, room - (previewVisible ? layout.preview : 0))],
        preview: [150, Math.max(150, room - layout.sidebar)],
        chat: [80, Math.max(80, window.innerHeight - 200)]
    }[name];
    return Math.round(Math.min(limits[1], Math.max(limits[0], value)));
}
const previewPane = document.querySelector('.preview-pane');

function applyLayout() {
    const root = document.documentElement.style;
    root.setProperty('--sidebar-w', `${layout.sidebar}px`);
    root.setProperty('--preview-w', `${layout.preview}px`);
    root.setProperty('--chat-h', `${layout.chat}px`);
}

function setupLayout() {
    applyLayout();
    const splitters = [
        // sign: +1 when moving right/down makes the pane bigger, -1 when it makes it smaller
        { id: 'splitSidebar', name: 'sidebar', axis: 'x', sign: 1 },
        { id: 'splitPreview', name: 'preview', axis: 'x', sign: -1 },
        { id: 'splitChat', name: 'chat', axis: 'y', sign: -1 }
    ];
    for (const { id, name, axis, sign } of splitters) {
        const handle = document.getElementById(id);
        const setSize = (value) => {
            layout[name] = clampLayout(name, value);
            handle.setAttribute('aria-valuenow', layout[name]);
            applyLayout();
        };
        handle.setAttribute('aria-valuenow', layout[name]);

        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            handle.setPointerCapture(e.pointerId);
            const start = axis === 'x' ? e.clientX : e.clientY;
            const startSize = layout[name];
            handle.classList.add('dragging');
            document.body.classList.add('resizing');
            document.body.classList.toggle('vertical', axis === 'y');

            const move = (ev) => setSize(startSize + sign * ((axis === 'x' ? ev.clientX : ev.clientY) - start));
            const end = () => {
                handle.classList.remove('dragging');
                document.body.classList.remove('resizing', 'vertical');
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', end);
                handle.removeEventListener('pointercancel', end);
                saveJSON('layout', layout);
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', end);
            handle.addEventListener('pointercancel', end);
        });

        // Keyboard: arrow keys nudge by 16px (64px with Shift); Home resets.
        handle.addEventListener('keydown', (e) => {
            const keys = axis === 'x' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 };
            if (e.key === 'Home') {
                setSize(LAYOUT_DEFAULTS[name]);
            } else if (keys[e.key]) {
                setSize(layout[name] + sign * keys[e.key] * (e.shiftKey ? 64 : 16));
            } else {
                return;
            }
            e.preventDefault();
            saveJSON('layout', layout);
        });
        handle.addEventListener('dblclick', () => {
            setSize(LAYOUT_DEFAULTS[name]);
            saveJSON('layout', layout);
        });
    }

    // The window can shrink under a saved layout; re-check the limits, and redraw the PDF at the new width.
    const rerender = debounce(() => {
        if (Math.abs(pdfPreview.clientWidth - lastRenderWidth) > 1) renderPDF();
    }, 200);
    window.addEventListener('resize', () => {
        for (const name of ['sidebar', 'preview', 'chat']) layout[name] = clampLayout(name, layout[name]);
        applyLayout();
    });
    new ResizeObserver(rerender).observe(pdfPreview);
}

// ---- Zoom: editor text size and PDF preview ----
const EDITOR_FONT = { min: 8, max: 40, default: 13 };
const PDF_ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const zoom = { editor: EDITOR_FONT.default, pdf: 1, ...loadJSON('zoom', {}) };
zoom.editor = Math.min(EDITOR_FONT.max, Math.max(EDITOR_FONT.min, Number(zoom.editor) || EDITOR_FONT.default));
zoom.pdf = PDF_ZOOM_STEPS.includes(zoom.pdf) ? zoom.pdf : 1;

function applyEditorZoom() {
    document.documentElement.style.setProperty('--editor-font', `${zoom.editor}px`);
    editorZoomReset.textContent = `${zoom.editor}px`;
    editorZoomOut.disabled = zoom.editor <= EDITOR_FONT.min;
    editorZoomIn.disabled = zoom.editor >= EDITOR_FONT.max;
    saveJSON('zoom', zoom);
}

function setEditorZoom(size) {
    zoom.editor = Math.min(EDITOR_FONT.max, Math.max(EDITOR_FONT.min, size));
    applyEditorZoom();
}

function applyPdfZoom(redraw = true) {
    pdfZoomReset.textContent = `${Math.round(zoom.pdf * 100)}%`;
    pdfZoomOut.disabled = zoom.pdf <= PDF_ZOOM_STEPS[0];
    pdfZoomIn.disabled = zoom.pdf >= PDF_ZOOM_STEPS[PDF_ZOOM_STEPS.length - 1];
    saveJSON('zoom', zoom);
    if (redraw) renderPDF();
}

function stepPdfZoom(direction) {
    const i = PDF_ZOOM_STEPS.indexOf(zoom.pdf);
    zoom.pdf = PDF_ZOOM_STEPS[Math.min(PDF_ZOOM_STEPS.length - 1, Math.max(0, i + direction))];
    applyPdfZoom();
}

function setupZoom() {
    applyEditorZoom();
    applyPdfZoom(false);

    editorZoomOut.addEventListener('click', () => setEditorZoom(zoom.editor - 1));
    editorZoomIn.addEventListener('click', () => setEditorZoom(zoom.editor + 1));
    editorZoomReset.addEventListener('click', () => setEditorZoom(EDITOR_FONT.default));
    pdfZoomOut.addEventListener('click', () => stepPdfZoom(-1));
    pdfZoomIn.addEventListener('click', () => stepPdfZoom(1));
    pdfZoomReset.addEventListener('click', () => {
        zoom.pdf = 1;
        applyPdfZoom();
    });

    // Ctrl/Cmd + = / - / 0 inside the editor change its text size instead of the whole page's zoom.
    editor.addEventListener('keydown', (e) => {
        if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
        const action = { '=': () => setEditorZoom(zoom.editor + 1), '+': () => setEditorZoom(zoom.editor + 1),
            '-': () => setEditorZoom(zoom.editor - 1), '0': () => setEditorZoom(EDITOR_FONT.default) }[e.key];
        if (action) {
            e.preventDefault();
            action();
        }
    });

    // Ctrl + scroll (and trackpad pinch, which browsers report as ctrl + wheel) zooms the pane under the pointer.
    let wheelLock = false;
    const throttled = (fn) => (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        if (wheelLock) return;
        wheelLock = true;
        setTimeout(() => { wheelLock = false; }, 80);
        fn(e);
    };
    pdfPreview.addEventListener('wheel', throttled((e) => stepPdfZoom(e.deltaY < 0 ? 1 : -1)), { passive: false });
    editor.addEventListener('wheel', throttled((e) => setEditorZoom(zoom.editor + (e.deltaY < 0 ? 1 : -1))), { passive: false });
}

// Utilities
let storageWarned = false;
function saveState() {
    try {
        localStorage.setItem('latexFiles', JSON.stringify(state.files));
        localStorage.setItem('currentFile', state.currentFile || '');
        localStorage.setItem('chatHistory', JSON.stringify(state.chatHistory));
        localStorage.setItem('dirtyFiles', JSON.stringify([...state.dirty]));
    } catch (error) {
        // Quota exceeded or storage blocked: tell the user once rather than losing work silently.
        if (!storageWarned) {
            storageWarned = true;
            alert('Could not save to browser storage (' + error.name + '). Your changes are kept only until you close this tab.');
        }
    }
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// PDF.js setup
const pdfjsLib = window['pdfjs-dist/build/pdf'];
if (pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
