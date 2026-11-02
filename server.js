const express = require('express');
const crypto = require('crypto');
const { TrifleClient, loadConfig } = require('./trifle');
const { loadProviders, probe, listModels } = require('./providers');
const { runTask } = require('./assistant');
const { describe: describeEdit } = require('./public/edits');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Load .env if present (Node >= 20.12); real environment variables win.
try {
    if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));
} catch (error) {
    console.warn('Could not load .env:', error.message);
}

const app = express();
const PORT = process.env.PORT || 3000;
// Loopback by default: the compile endpoint runs a TeX engine, so it must not be reachable from the LAN
// unless you ask for it (HOST=0.0.0.0, as docker-compose does behind a 127.0.0.1 port mapping).
const HOST = process.env.HOST || '127.0.0.1';
// TeX engines the editor can run. `timeoutMs` is per pass: LuaLaTeX/XeLaTeX build a font database the first
// time they run, which can take well over 30 s.
const ENGINES = {
    pdflatex: { label: 'pdfLaTeX', command: process.env.PDFLATEX_PATH || 'pdflatex', timeoutMs: 30000, env: 'PDFLATEX_PATH' },
    lualatex: { label: 'LuaLaTeX', command: process.env.LUALATEX_PATH || 'lualatex', timeoutMs: 120000, env: 'LUALATEX_PATH' },
    xelatex: { label: 'XeLaTeX', command: process.env.XELATEX_PATH || 'xelatex', timeoutMs: 120000, env: 'XELATEX_PATH' }
};
const BIBTEX = process.env.BIBTEX_PATH || 'bibtex';
const BIBER = process.env.BIBER_PATH || 'biber';
// A GUI-launched Node often lacks the TeX directory on PATH (MacTeX installs to /Library/TeX/texbin).
const TEX_DIRS = ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin'];
const TOOL_PATH = [process.env.PATH, ...TEX_DIRS.filter((dir) => fs.existsSync(dir))].filter(Boolean).join(path.delimiter);

function findExecutable(command) {
    const candidates = command.includes(path.sep) ? [command] : TOOL_PATH.split(path.delimiter).map((dir) => path.join(dir, command));
    return candidates.find((candidate) => {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return fs.statSync(candidate).isFile();
        } catch {
            return false;
        }
    }) || null;
}

const MAX_CONCURRENT_COMPILES = 2;
const MAX_MESSAGE_CHARS = 10000;

// Host names the app answers to. Checking Host (not only Origin) stops DNS-rebinding, where a hostile site
// resolves its own name to 127.0.0.1 and becomes "same origin" with this server.
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]',
    ...(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)]);

function hostname(hostHeader) {
    try {
        return new URL(`http://${hostHeader}`).hostname;
    } catch {
        return null;
    }
}

// Same-origin only: no CORS headers are sent, and cross-site or rebinding requests are refused.
app.use('/api', (req, res, next) => {
    const host = hostname(req.headers.host);
    if (!host || !ALLOWED_HOSTS.has(host)) {
        return res.status(403).json({ error: 'Host not allowed' });
    }
    const origin = req.headers.origin;
    if (origin) {
        let originHost = null;
        try {
            originHost = new URL(origin).host;
        } catch { /* malformed Origin is refused below */ }
        if (originHost !== req.headers.host) {
            return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
        }
    }
    next();
});

app.use(express.json({ limit: '10mb' }));
// Only the front end is served; the project root (server code, documents, .env) is not.
app.use(express.static(path.join(__dirname, 'public')));

// ---- Workspace file browser -------------------------------------------------------------------------
// The browser may list, open and save text files under one folder only (WORKSPACE_DIR, default ./documents).
// Every path from the client is resolved through realpath and must stay inside that folder, so "..",
// absolute paths and symlinks pointing outside are all refused.
const WORKSPACE_ENV = process.env.WORKSPACE_DIR || path.join(__dirname, 'documents');
let WORKSPACE = null;
try {
    WORKSPACE = fs.realpathSync(path.resolve(WORKSPACE_ENV));
} catch {
    console.warn(`Workspace folder not found (${WORKSPACE_ENV}); the file browser is disabled. Set WORKSPACE_DIR.`);
}
const EDITABLE_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const HIDDEN_DIRS = new Set(['node_modules', '__pycache__']);

class FsError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const isInside = (p) => p === WORKSPACE || p.startsWith(WORKSPACE + path.sep);

// Resolve a workspace-relative path ('' = the root) to an absolute, symlink-free path inside the workspace.
// With allowMissingLeaf, the final component may not exist yet (new file); its parent must.
function resolveInWorkspace(rel, { allowMissingLeaf = false } = {}) {
    if (!WORKSPACE) throw new FsError(404, 'No workspace folder is configured');
    if (typeof rel !== 'string' || rel.includes('\0')) throw new FsError(400, 'Invalid path');
    const target = path.resolve(WORKSPACE, rel);
    if (!isInside(target)) throw new FsError(403, 'Path is outside the workspace');
    // Hidden entries (.git, .env, …) are not listed, so they cannot be opened or written by name either.
    if (path.relative(WORKSPACE, target).split(path.sep).some((part) => part.startsWith('.'))) {
        throw new FsError(403, 'Hidden files are not available');
    }
    try {
        const real = fs.realpathSync(target);
        if (!isInside(real)) throw new FsError(403, 'Path is outside the workspace');
        return real;
    } catch (error) {
        if (error instanceof FsError) throw error;
        if (error.code !== 'ENOENT' || !allowMissingLeaf) throw new FsError(404, 'Not found');
        let parent;
        try {
            parent = fs.realpathSync(path.dirname(target));
        } catch {
            throw new FsError(404, 'Folder not found');
        }
        if (!isInside(parent)) throw new FsError(403, 'Path is outside the workspace');
        return path.join(parent, path.basename(target));
    }
}

const relativeToWorkspace = (abs) => path.relative(WORKSPACE, abs).split(path.sep).join('/');
const isEditable = (name) => EDITABLE_EXTS.has(path.extname(name).toLowerCase());

app.get('/api/fs/list', (req, res, next) => {
    try {
        const dir = resolveInWorkspace(req.query.path || '');
        if (!fs.statSync(dir).isDirectory()) throw new FsError(400, 'Not a folder');

        const entries = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || HIDDEN_DIRS.has(entry.name)) continue;
            let abs;
            let stat;
            try {
                abs = fs.realpathSync(path.join(dir, entry.name));
                if (!isInside(abs)) continue; // symlink leading out of the workspace
                stat = fs.statSync(abs);
            } catch {
                continue; // broken link or unreadable
            }
            if (stat.isDirectory()) {
                entries.push({ name: entry.name, type: 'dir' });
            } else if (stat.isFile()) {
                entries.push({ name: entry.name, type: 'file', size: stat.size, editable: isEditable(entry.name) });
            }
        }
        entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
        res.json({ path: relativeToWorkspace(dir), root: path.basename(WORKSPACE), entries });
    } catch (error) {
        next(error);
    }
});

app.get('/api/fs/file', (req, res, next) => {
    try {
        const file = resolveInWorkspace(req.query.path);
        if (!isEditable(file)) throw new FsError(415, 'Only text files (' + [...EDITABLE_EXTS].join(', ') + ') can be opened');
        const stat = fs.statSync(file);
        if (!stat.isFile()) throw new FsError(400, 'Not a file');
        if (stat.size > MAX_FILE_BYTES) throw new FsError(413, 'File is larger than 2 MB');
        const buffer = fs.readFileSync(file);
        if (buffer.includes(0)) throw new FsError(415, 'File looks binary');
        res.json({ path: relativeToWorkspace(file), content: buffer.toString('utf8') });
    } catch (error) {
        next(error);
    }
});

// Save (or create) a text file. Only an explicit save from the editor calls this; nothing autosaves to disk.
app.put('/api/fs/file', (req, res, next) => {
    try {
        const { path: rel, content } = req.body || {};
        if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) {
            throw new FsError(400, 'Content must be text under 2 MB');
        }
        if (typeof rel !== 'string' || !rel) throw new FsError(400, 'Invalid path');
        const file = resolveInWorkspace(rel, { allowMissingLeaf: true });
        if (file === WORKSPACE) throw new FsError(400, 'Not a file');
        if (!isEditable(file)) throw new FsError(415, 'Only text files (' + [...EDITABLE_EXTS].join(', ') + ') can be saved');
        if (fs.existsSync(file) && !fs.statSync(file).isFile()) throw new FsError(400, 'Not a file');
        fs.writeFileSync(file, content);
        res.json({ path: relativeToWorkspace(file), saved: true });
    } catch (error) {
        next(error);
    }
});

// LaTeX Compilation Endpoint
let activeCompiles = 0;
app.post('/api/compile', async (req, res) => {
    // texContent: the main file's text. path (optional): where it lives in the workspace, which makes the
    // compile run over that file's whole folder. overrides (optional): unsaved edits of other open files,
    // as { "<workspace path>": "<text>" }.
    const { texContent, path: mainPath, overrides, engine: requestedEngine } = req.body || {};

    if (typeof texContent !== 'string' || !texContent) {
        return res.status(400).json({ error: 'No LaTeX content provided' });
    }
    if (activeCompiles >= MAX_CONCURRENT_COMPILES) {
        return res.status(503).json({ error: 'Compiler busy', details: 'Too many compilations in progress; try again shortly.' });
    }

    activeCompiles++;
    try {
        const { pdf, notes, engine } = await compileLaTeXToPDF(texContent, mainPath, overrides, requestedEngine);
        res.setHeader('X-Compile-Engine', engine);
        res.setHeader('Content-Type', 'application/pdf');
        if (notes.length) res.setHeader('X-Compile-Notes', encodeURIComponent(notes.join('; ')));
        res.send(pdf);
    } catch (error) {
        console.error('Compilation error:', error.message.split('\n')[0]);
        res.status(error instanceof FsError ? error.status : 500).json({
            error: 'LaTeX compilation failed',
            details: error.message
        });
    } finally {
        activeCompiles--;
    }
});

// ---- Assistant ----
// Task oriented: the editor builds the context (assistant.js), a model provider answers (providers.js), and a proposed
// change comes back as edit blocks that the browser shows as a diff. Nothing here writes to a file.
const trifle = new TrifleClient(loadConfig(), { timeoutMs: Number(process.env.TRIFLE_TIMEOUT_MS) || 300000 });
let providerConfig;
try {
    providerConfig = loadProviders(process.env, { trifleEnabled: trifle.enabled });
} catch (error) {
    console.error('Providers:', error.message);
    providerConfig = { providers: [], preferred: '', file: null, error: error.message };
}
const providerById = new Map(providerConfig.providers.map((provider) => [provider.id, provider]));
let assistantBusy = false;

// Probing a local model server on every page load is cheap, but not on every keystroke of a script: remember briefly.
const probeCache = new Map();
async function providerState(provider) {
    const cached = probeCache.get(provider.id);
    if (cached && Date.now() - cached.at < 3000) return cached.value;
    const value = await probe(provider, { trifle });
    probeCache.set(provider.id, { at: Date.now(), value });
    return value;
}

// The models a provider offers. A local server is asked often (models come and go as the user downloads them); a hosted
// one costs a network call, so its list is kept longer.
const modelCache = new Map();
async function providerModels(provider, ready) {
    if (!ready) return [];
    const cached = modelCache.get(provider.id);
    if (cached && Date.now() - cached.at < (provider.local ? 3000 : 60000)) return cached.value;
    const value = await listModels(provider);
    modelCache.set(provider.id, { at: Date.now(), value });
    return value;
}

app.get('/api/assistant', async (req, res) => {
    const states = await Promise.all(providerConfig.providers.map(providerState));
    const models = await Promise.all(providerConfig.providers.map((p, i) => providerModels(p, states[i].ready)));
    const list = providerConfig.providers.map((p, i) => ({
        id: p.id, label: p.label, kind: p.kind, model: p.model, models: models[i], local: p.local, host: p.host,
        ready: states[i].ready, detail: states[i].detail
    }));
    const preferred = list.find((p) => p.id === providerConfig.preferred && p.ready);
    const chosen = preferred || list.find((p) => p.ready && p.local) || list.find((p) => p.ready) || list[0];
    res.json({ providers: list, default: chosen ? chosen.id : '', error: providerConfig.error || '' });
});

// Streams newline-delimited JSON: { type: 'text', text } as the answer arrives, { type: 'reset', text } when it is
// replaced, { type: 'retry', reason } when an edit did not fit and the model is asked again, then { type: 'done', text,
// truncated, failures } or { type: 'error', message }.
app.post('/api/chat', async (req, res) => {
    const body = req.body || {};
    let provider = providerById.get(body.provider);
    if (!provider) return res.status(400).json({ error: 'Unknown provider', details: 'Choose a provider from the list above the chat.' });
    // The model picked in the editor replaces the provider's configured one for this question only.
    if (body.model !== undefined && body.model !== '') {
        if (typeof body.model !== 'string' || body.model.length > 200 || /[\u0000-\u001f]/.test(body.model)) {
            return res.status(400).json({ error: 'Model must be a name under 200 characters' });
        }
        if (provider.kind !== 'trifle') provider = { ...provider, model: body.model.trim() };
    }
    if (typeof body.message !== 'string' || body.message.length > MAX_MESSAGE_CHARS) {
        return res.status(400).json({ error: 'Message must be text under ' + MAX_MESSAGE_CHARS + ' characters' });
    }
    if (typeof body.texContent !== 'string' || !body.texContent || body.texContent.length > MAX_FILE_BYTES) {
        return res.status(400).json({ error: 'Open a file first', details: 'The assistant works on the file open in the editor (up to 2 MB).' });
    }
    if (!body.message.trim() && !['fix', 'explain'].includes(body.task)) {
        return res.status(400).json({ error: 'Message must not be empty' });
    }
    if (assistantBusy) {
        return res.status(409).json({ error: 'The assistant is still answering the previous message.', details: 'Wait for it to finish, or press Stop.' });
    }

    const document = body.texContent;
    const offset = (value, fallback) => (Number.isInteger(value) ? Math.min(Math.max(value, 0), document.length) : fallback);
    const selStart = offset(body.selStart, 0);
    const context = {
        fileName: typeof body.fileName === 'string' ? body.fileName.slice(0, 300) : '',
        document,
        selStart,
        selEnd: Math.max(selStart, offset(body.selEnd, selStart)),
        cursor: offset(body.cursor, -1),
        compileError: typeof body.compileError === 'string' ? body.compileError.slice(0, 6000) : ''
    };

    assistantBusy = true;
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event) => {
        if (!res.writableEnded && !controller.signal.aborted) res.write(JSON.stringify(event) + '\n');
    };

    try {
        const result = await runTask({
            provider, task: body.task, message: body.message, context, history: body.history,
            signal: controller.signal, emit: send, trifle
        });
        send({
            type: 'done',
            text: result.text,
            truncated: result.truncated,
            failures: result.failures.map((f) => ({ index: f.index, reason: describeEdit(f) }))
        });
    } catch (error) {
        if (!controller.signal.aborted) {
            console.error('Assistant error:', error.message);
            send({ type: 'error', message: error.message });
        }
    } finally {
        assistantBusy = false;
        if (!res.writableEnded) res.end();
    }
});

// Run one TeX tool (pdflatex, bibtex, biber) in `cwd`. Never blocks the event loop; the child is killed on
// timeout. Resolves { output, code }; rejects only if the tool cannot be started or times out.
function runTool(command, args, cwd, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const executable = findExecutable(command);
        if (!executable) {
            const err = new Error(`${command} was not found. Install a TeX distribution (macOS: MacTeX; Linux: texlive) `
                + `or set ${path.basename(command).toUpperCase()}_PATH in .env to the full path of the tool.`);
            err.missing = true;
            return reject(err);
        }
        const child = spawn(executable, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            // Paranoid file access: TeX may only read and write inside the working directory (plus its own
            // TeX trees), so \input{/etc/passwd} or \input{../server.js} fail instead of leaking into the PDF.
            // HOME stays the real one: LuaLaTeX and Biber keep their font and parse caches there, and a throwaway
            // HOME would rebuild them (minutes) on every compile.
            env: { PATH: TOOL_PATH, HOME: process.env.HOME || os.homedir(), openin_any: 'p', openout_any: 'p' }
        });

        let output = '';
        const collect = (chunk) => { if (output.length < 1e6) output += chunk; };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${path.basename(command)} timed out after ${timeoutMs / 1000}s`
                + (/lua|xe/.test(command) ? ' (the first run builds a font cache and can take longer; try again)' : '')));
        }, timeoutMs);

        child.on('error', (error) => {
            clearTimeout(timer);
            const missing = error.code === 'ENOENT';
            const err = new Error(`${path.basename(command)} could not be started (${command}): ${error.message}`);
            err.missing = missing;
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ output, code });
        });
    });
}

const runEngine = (engine, cwd) => runTool(ENGINES[engine].command,
    ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', 'document.tex'], cwd, ENGINES[engine].timeoutMs);

// Which engine to use. An explicit choice wins; "auto" reads a magic comment ("% !TEX program = lualatex",
// as written by TeXShop, TeXworks and VS Code) in the first lines, then looks for Lua-only or OpenType-font code.
function pickEngine(requested, source) {
    if (requested && requested !== 'auto') {
        if (!Object.prototype.hasOwnProperty.call(ENGINES, requested)) throw new FsError(400, `Unknown engine "${requested}"`);
        return requested;
    }
    const magic = source.split('\n', 30).join('\n').match(/^\s*%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im);
    if (magic && Object.prototype.hasOwnProperty.call(ENGINES, magic[1].toLowerCase())) return magic[1].toLowerCase();
    if (/\\(?:directlua|luaexec)\b|\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{(?:luacode|luatexbase|lualatex-math|luacolor)\}/.test(source)) return 'lualatex';
    if (/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{(?:fontspec|unicode-math|polyglossia)\}/.test(source)) return 'lualatex';
    return 'pdflatex';
}

// The error lines TeX reports ("! ..." plus the context after them), falling back to the tail of the output.
function summariseLog(log) {
    const lines = log.split('\n');
    const out = [];
    lines.forEach((line, i) => {
        if (line.startsWith('!') && !/Fatal error occurred/.test(line)) out.push(...lines.slice(i, i + 3));
        // LuaTeX reports errors raised in Lua code without a leading "!": "[\directlua]:1: message" + traceback.
        else if (/^\[\\\w*lua\w*\]:\d+:|^\S.*\.lua:\d+:/.test(line)) out.push(...lines.slice(i, i + 8));
    });
    return (out.length ? out.join('\n') : lines.slice(-30).join('\n')).slice(0, 4000);
}

// ---- Project compile: copy the main file's folder into a scratch directory ----
// File types a document may pull in (images, bibliographies, styles, data). Everything else is left behind.
const PROJECT_EXTS = new Set([...EDITABLE_EXTS, '.def', '.cfg', '.clo', '.ltx', '.bbx', '.cbx', '.lbx', '.ist', '.bbl',
    '.csv', '.dat', '.tikz', '.lua', '.png', '.jpg', '.jpeg', '.pdf', '.eps', '.ttf', '.otf']);
const MAX_PROJECT_FILES = 3000;
const MAX_PROJECT_BYTES = 100 * 1024 * 1024;
const MAX_PROJECT_DEPTH = 8;

// Copies srcDir into destDir (both absolute). Only regular files with a known extension are copied, hidden
// entries and symlinks that leave the workspace are skipped, and `ancestors` stops symlink loops.
function copyProject(srcDir, destDir, budget, ancestors = new Set(), depth = 0) {
    if (depth > MAX_PROJECT_DEPTH) return;
    ancestors.add(srcDir);
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || HIDDEN_DIRS.has(entry.name)) continue;
        let abs;
        let stat;
        try {
            abs = fs.realpathSync(path.join(srcDir, entry.name));
            if (!isInside(abs)) continue;
            stat = fs.statSync(abs);
        } catch {
            continue;
        }
        const dest = path.join(destDir, entry.name);
        if (stat.isDirectory()) {
            if (ancestors.has(abs)) continue;
            fs.mkdirSync(dest);
            copyProject(abs, dest, budget, ancestors, depth + 1);
        } else if (stat.isFile() && PROJECT_EXTS.has(path.extname(entry.name).toLowerCase())) {
            budget.files++;
            budget.bytes += stat.size;
            if (budget.files > MAX_PROJECT_FILES || budget.bytes > MAX_PROJECT_BYTES) {
                throw new FsError(413, 'This folder is too large to compile as a project (limit 3000 files / 100 MB). Move the document into its own folder.');
            }
            fs.copyFileSync(abs, dest);
        }
    }
    ancestors.delete(srcDir);
}

// Overlay the editor's unsaved text onto the scratch copy, so the PDF shows what you see, not what is on disk.
function applyOverrides(overrides, projectRel, scratchDir) {
    if (!overrides || typeof overrides !== 'object') return;
    for (const [rel, content] of Object.entries(overrides)) {
        if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) continue;
        if (!isEditable(rel) || rel.includes('\0')) continue;
        const inProject = path.posix.relative(projectRel || '.', rel);
        if (inProject.startsWith('..') || path.isAbsolute(inProject)) continue; // another project
        const target = path.resolve(scratchDir, inProject);
        if (!target.startsWith(scratchDir + path.sep)) continue;
        if (inProject.split('/').some((part) => part.startsWith('.'))) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
}

async function compileLaTeXToPDF(texContent, mainPath, overrides, requestedEngine) {
    const engine = pickEngine(requestedEngine, texContent);
    if (!/\\documentclass/.test(texContent)) {
        throw new Error('This file has no \\documentclass, so it cannot be compiled on its own.'
            + ' It is probably included from another file with \\input; open and compile that main file instead.');
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-'));
    const pdfFile = path.join(tempDir, 'document.pdf');
    const notes = [];

    try {
        if (typeof mainPath === 'string' && mainPath) {
            const mainAbs = resolveInWorkspace(mainPath);
            if (path.extname(mainAbs).toLowerCase() !== '.tex') throw new FsError(400, 'Only .tex files can be compiled');
            copyProject(path.dirname(mainAbs), tempDir, { files: 0, bytes: 0 });
            applyOverrides(overrides, path.posix.dirname(relativeToWorkspace(mainAbs)), tempDir);
        }
        // The main file is always compiled as document.tex, whatever it is called on disk.
        fs.writeFileSync(path.join(tempDir, 'document.tex'), texContent);

        const failed = async (pass) => {
            if (pass.code !== 0 || !fs.existsSync(pdfFile)) {
                throw new Error(`PDF generation failed\n${summariseLog(pass.output)}`);
            }
        };
        // "undefined references" only justifies one extra pass: if a reference is genuinely missing it stays
        // undefined however often TeX runs, so later passes look for TeX's own "rerun" requests only.
        const needsRerun = (log, firstPass = false) => /Rerun to get|Label\(s\) may have changed/i.test(log) || (firstPass && /undefined references/i.test(log));

        let pass = await runEngine(engine, tempDir);
        await failed(pass);

        // Bibliography: BibTeX (\bibliography) or Biber (biblatex), if the first pass asked for one.
        const read = (name) => (fs.existsSync(path.join(tempDir, name)) ? fs.readFileSync(path.join(tempDir, name), 'utf8') : '');
        const tool = /\\bibdata\{/.test(read('document.aux')) ? [BIBTEX, 'bibtex']
            : fs.existsSync(path.join(tempDir, 'document.bcf')) ? [BIBER, 'biber'] : null;
        let rerun = needsRerun(pass.output, true);
        if (tool) {
            try {
                const result = await runTool(tool[0], ['document'], tempDir);
                if (result.code !== 0) notes.push(`${tool[1]} reported problems; some citations may be unresolved`);
            } catch (error) {
                if (!error.missing) throw error;
                notes.push(`${tool[1]} is not installed, so citations are unresolved`);
            }
            rerun = true;
        }

        // Re-run until references settle (at most five passes in all).
        for (let i = 0; i < 4 && rerun; i++) {
            pass = await runEngine(engine, tempDir);
            await failed(pass);
            rerun = needsRerun(pass.output);
        }

        return { pdf: fs.readFileSync(pdfFile), notes, engine };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

// Error handling
app.use((err, req, res, next) => {
    if (!(err instanceof FsError)) console.error('Server error:', err.message);
    res.status(err.status || 500).json({
        error: err instanceof FsError ? err.message : 'Internal server error',
        message: err.message
    });
});

app.listen(PORT, HOST, () => {
    console.log(`LaTeX Editor running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log('\nConfiguration:');
    console.log(`- Listening on: ${HOST}`);
    for (const provider of providerConfig.providers) {
        console.log(`- Assistant ${provider.id}: ${provider.kind} ${provider.model || ''} ${provider.url || ''}${provider.local ? '' : ' (sends the open file to ' + (provider.host || 'a remote service') + ')'}`);
    }
    if (providerConfig.error) console.log(`- Assistant: ${providerConfig.error}`);
    for (const [name, engine] of Object.entries(ENGINES)) {
        console.log(`- ${name}: ${findExecutable(engine.command) || 'NOT FOUND (install a TeX distribution or set ' + engine.env + ')'}`);
    }
    console.log(`- Workspace: ${WORKSPACE || 'none (file browser disabled)'}`);
});
