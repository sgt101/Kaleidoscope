// Version history: each Save of a workspace file becomes a version (a Git commit) in a repository Kaleidoscope owns,
// by default <workspace>/.kaleidoscope/history.git. See docs/version-control.md.
//
// Git is run like TeX: no shell, a timeout, capped output, and an environment that ignores system and user settings.
// The repository is bare and Git is never given a work tree, so .gitattributes files, filters and hooks cannot run
// anything; file contents are read with `hash-object --no-filters`. The repository's own config is replaced at every
// start, because a folder copied from elsewhere could carry a planted .kaleidoscope whose config names commands.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ZERO = '0'.repeat(40);
const ID = /^[0-9a-f]{40}$/;
const MIN_GIT = [2, 32]; // GIT_CONFIG_GLOBAL and GIT_CONFIG_COUNT
const MAX_FILES = 20000;
const MAX_DEPTH = 20;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const LIST_FILES = 100; // files listed per version; the count covers the rest
// A file changed this recently is read again next time: its size and time could stay the same through another change.
const RACY_MS = 3000;
const CONTROL = /[\u0000-\u001f\u007f]/;
const REPO_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tfilemode = false\n\tlogallrefupdates = false\n';
// Applied to every Git command on top of (and overriding) the repository's own config.
const SETTINGS = {
    'core.hooksPath': os.devNull,
    'core.fsmonitor': 'false',
    'core.attributesFile': os.devNull,
    'core.pager': 'cat',
    'safe.bareRepository': 'explicit',
    'protocol.allow': 'never',
    'protocol.file.allow': 'always',
    'protocol.https.allow': 'always',
    'commit.gpgSign': 'false',
    'log.showSignature': 'false',
    'gc.auto': '0',
    'maintenance.auto': 'false'
};
const SUBJECTS = {
    first: 'Files when history started',
    external: 'Changes made outside Kaleidoscope'
};
// %x1e starts a version, %x1f separates its fields, %x1d separates the values of a repeated trailer.
const LOG_FORMAT = '%x1e%H%x1f%P%x1f%ct%x1f%s%x1f%(trailers:key=Kaleidoscope-Reason,valueonly,separator=%x1d)'
    + '%x1f%(trailers:key=Kaleidoscope-Path,valueonly,separator=%x1d)%x1f';

class HistoryError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// A workspace-relative path from the browser, checked without touching the disk (the file may no longer exist).
// '' means the whole workspace.
function cleanPath(rel) {
    if (rel === undefined || rel === '') return '';
    if (typeof rel !== 'string' || rel.length > 4096 || CONTROL.test(rel)) throw new HistoryError(400, 'Invalid path');
    const parts = rel.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
        throw new HistoryError(400, 'Invalid path');
    }
    return rel;
}

function checkId(id, what = 'version') {
    if (typeof id !== 'string' || !ID.test(id)) throw new HistoryError(400, `Invalid ${what} id`);
    return id;
}

function gitEnv(extra) {
    const env = {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: process.env.HOME || os.homedir(),
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_ATTR_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_LITERAL_PATHSPECS: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_COUNT: String(Object.keys(SETTINGS).length)
    };
    Object.entries(SETTINGS).forEach(([key, value], i) => {
        env[`GIT_CONFIG_KEY_${i}`] = key;
        env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
    return { ...env, ...extra };
}

// Run git with an argument array. Resolves stdout as a Buffer; rejects with Git's own message on failure.
function run(git, args, { input, env, cwd, timeoutMs = 30000, maxBytes = 64 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(git, args, { cwd: cwd || os.tmpdir(), env: gitEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
        const out = [];
        let size = 0;
        let err = '';
        let failed = null;
        const fail = (error) => {
            if (!failed) failed = error;
            child.kill('SIGKILL');
        };
        const timer = setTimeout(() => fail(new Error(`git ${args[0]} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        child.stdout.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) fail(new Error(`git ${args[0]} produced more output than expected`));
            else out.push(chunk);
        });
        child.stderr.on('data', (chunk) => { if (err.length < 8000) err += chunk; });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error.code === 'ENOENT' ? Object.assign(new Error(`Git was not found (${git})`), { missing: true }) : error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (failed) return reject(failed);
            if (code !== 0) {
                const message = err.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3).join(' ');
                return reject(Object.assign(new Error(message || `git ${args[0]} failed (exit ${code})`), { code }));
            }
            resolve(Buffer.concat(out));
        });
        child.stdin.on('error', () => { /* git may exit before reading all of its input */ });
        child.stdin.end(input === undefined ? '' : input);
    });
}

// The workspace files history keeps: Map of relative path -> { size, mtimeMs }. Hidden entries, symbolic links,
// file types outside `include` and files over the size limit are left out.
function walk(root, { include, skipDirs, skipAbs, maxFileBytes }) {
    const files = new Map();
    const visit = (dir, rel, depth) => {
        if (depth > MAX_DEPTH) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const name = entry.name;
            if (name.startsWith('.') || skipDirs.has(name) || CONTROL.test(name)) continue;
            const abs = path.join(dir, name);
            const childRel = rel ? `${rel}/${name}` : name;
            if (entry.isDirectory()) {
                if (abs !== skipAbs) visit(abs, childRel, depth + 1);
            } else if (entry.isFile() && include(name)) {
                let stat;
                try {
                    stat = fs.lstatSync(abs);
                } catch {
                    continue;
                }
                if (!stat.isFile() || stat.size > maxFileBytes) continue;
                files.set(childRel, { size: stat.size, mtimeMs: stat.mtimeMs });
                if (files.size > MAX_FILES) {
                    throw new HistoryError(413, `The workspace has more than ${MAX_FILES} files history would keep`);
                }
            }
        }
    };
    visit(root, '', 0);
    return files;
}

function parseLog(text) {
    return text.split('\x1e').slice(1).map((record) => {
        const end = record.indexOf('\0');
        const [id, parents, time, subject, reason, paths] = (end === -1 ? record : record.slice(0, end)).split('\x1f');
        const changes = end === -1 ? [] : record.slice(end + 1).replace(/^\n/, '').split('\0');
        const files = [];
        for (let i = 0; i + 1 < changes.length; i += 2) files.push({ status: changes[i], path: changes[i + 1] });
        return {
            id,
            parent: parents ? parents.split(' ')[0] : null,
            time: new Date(Number(time) * 1000).toISOString(),
            subject,
            reason: reason || '',
            paths: paths ? paths.split('\x1d') : [],
            fileCount: files.length,
            files: files.slice(0, LIST_FILES)
        };
    });
}

// One line for a commit message: no control characters, not too long.
const oneLine = (text) => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);

function listNames(paths) {
    if (paths.length === 1) return paths[0];
    if (paths.length === 2) return `${paths[0]} and ${paths[1]}`;
    return `${paths.length} files`;
}

function message(reason, paths) {
    const subject = reason === 'save' ? `Saved ${listNames(paths)}` : SUBJECTS[reason];
    const trailers = [`Kaleidoscope-Reason: ${reason}`];
    if (reason === 'save') trailers.push(...paths.map((p) => `Kaleidoscope-Path: ${p}`));
    return `${oneLine(subject)}\n\n${trailers.join('\n')}\n`;
}

function createHistory({
    workspace,
    dir = '.kaleidoscope/history.git',
    enabled = true,
    git: gitPath = 'git',
    include = () => true,
    skipDirs = new Set(),
    maxFileBytes = 25 * 1024 * 1024,
    author = { name: 'Kaleidoscope', email: 'kaleidoscope@localhost' }
} = {}) {
    const gitDir = workspace ? path.resolve(workspace, dir) : null;
    const identity = {
        GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email
    };
    const cacheFile = gitDir && path.join(gitDir, 'kaleidoscope-cache.json');
    const indexFile = gitDir && path.join(gitDir, 'kaleidoscope-index');
    const state = { enabled: false, reason: 'History is starting', version: '', error: '' };
    let cache = { head: null, files: new Map() }; // path -> { size, mtimeMs, oid }, valid while main is at `head`
    let tree = { head: null, files: new Map() }; // the files of the latest version
    const pending = new Map(); // saved path -> number of saves not yet in a version
    let queue = Promise.resolve();
    let queued = 0;
    let scheduled = false;

    const git = (args, options = {}) => run(gitPath, ['--git-dir=' + gitDir, ...args], options);

    // One Git operation at a time, in order.
    function locked(fn) {
        queued++;
        const result = queue.then(fn);
        queue = result.catch(() => {}).then(() => { queued--; });
        return result;
    }
    // Wait for queued versions, but not for ever: a first version of a large workspace can take a while.
    const settled = (ms) => Promise.race([queue, new Promise((resolve) => setTimeout(resolve, ms).unref())]);

    async function head() {
        try {
            return (await git(['rev-parse', '--verify', '-q', 'refs/heads/main'])).toString().trim();
        } catch (error) {
            if (error.code === 1) return null; // no versions yet
            throw error;
        }
    }

    async function filesAt(commit) {
        if (!commit) return new Map();
        if (tree.head === commit) return tree.files;
        const files = new Map();
        const out = (await git(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', commit])).toString();
        for (const line of out.split('\0')) {
            const tab = line.indexOf('\t');
            if (tab !== -1) files.set(line.slice(tab + 1), line.slice(0, tab).split(' ')[2]);
        }
        tree = { head: commit, files };
        return files;
    }

    function loadCache() {
        try {
            const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            const files = new Map();
            for (const [rel, [size, mtimeMs, oid]] of Object.entries(data.files || {})) {
                if (ID.test(oid)) files.set(rel, { size, mtimeMs, oid });
            }
            cache = { head: data.head || null, files };
        } catch {
            cache = { head: null, files: new Map() };
        }
    }

    function saveCache() {
        const files = {};
        for (const [rel, { size, mtimeMs, oid }] of cache.files) files[rel] = [size, mtimeMs, oid];
        const tmp = cacheFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ head: cache.head, files }));
        fs.renameSync(tmp, cacheFile);
    }

    // Write a version whose files are `files` (path -> blob id) on top of `parent`.
    async function commit(files, parent, text) {
        fs.rmSync(indexFile, { force: true });
        const env = { GIT_INDEX_FILE: indexFile };
        const entries = [...files].map(([rel, oid]) => `100644 ${oid}\t${rel}\0`).join('');
        await git(['update-index', '-z', '--index-info'], { input: entries, env });
        const treeId = (await git(['write-tree'], { env })).toString().trim();
        const args = ['commit-tree', treeId];
        if (parent) args.push('-p', parent);
        const id = (await git(args, { input: text, env: identity })).toString().trim();
        // Compare-and-swap: refused if main moved since `parent` was read.
        await git(['update-ref', 'refs/heads/main', id, parent || ZERO]);
        tree = { head: id, files };
        return id;
    }

    // Record what changed since the latest version. Changes to saved paths become a "save" version; anything else
    // that changed becomes an "external" version before it. Returns the ids of the versions made.
    async function snapshot(isSaved, reason) {
        const parent = await head();
        if (cache.head !== parent) cache = { head: null, files: new Map() };

        const found = walk(workspace, { include, skipDirs, skipAbs: gitDir, maxFileBytes });
        const files = new Map();
        const toRead = [];
        for (const [rel, info] of found) {
            const known = cache.files.get(rel);
            if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) files.set(rel, known.oid);
            else toRead.push(rel);
        }
        if (toRead.length) {
            // Absolute paths: a line starting with a quote would be read as a quoted name.
            const out = (await git(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
                input: toRead.map((rel) => path.join(workspace, rel)).join('\n') + '\n', timeoutMs: 600000
            })).toString().trim().split('\n');
            if (out.length !== toRead.length || !out.every((oid) => ID.test(oid))) throw new Error('git hash-object gave an unexpected answer');
            const now = Date.now();
            toRead.forEach((rel, i) => {
                files.set(rel, out[i]);
                const info = found.get(rel);
                if (now - info.mtimeMs > RACY_MS) cache.files.set(rel, { ...info, oid: out[i] });
                else cache.files.delete(rel);
            });
        }
        for (const rel of cache.files.keys()) if (!found.has(rel)) cache.files.delete(rel);

        const before = await filesAt(parent);
        const changed = [...new Set([...before.keys(), ...files.keys()])].filter((rel) => before.get(rel) !== files.get(rel)).sort();
        const made = [];
        let latest = parent;
        if (changed.length) {
            const saved = changed.filter(isSaved);
            const outside = changed.filter((rel) => !isSaved(rel));
            if (saved.length && outside.length) {
                // Changes made elsewhere go first, so the Save's version shows only what was saved.
                const middle = new Map(before);
                for (const rel of outside) {
                    if (files.has(rel)) middle.set(rel, files.get(rel));
                    else middle.delete(rel);
                }
                latest = await commit(middle, latest, message('external', outside));
                made.push(latest);
            }
            const kind = saved.length ? 'save' : (parent ? reason : 'first');
            latest = await commit(files, latest, message(kind, saved));
            made.push(latest);
        }
        cache.head = latest;
        saveCache();
        return made;
    }

    // A failed version is tried once more from scratch: a file can vanish while it is read, and a stale cache can
    // name an object the repository does not have.
    async function record(isSaved, reason) {
        try {
            return await snapshot(isSaved, reason);
        } catch (error) {
            if (error instanceof HistoryError) throw error;
            cache = { head: null, files: new Map() };
            tree = { head: null, files: new Map() };
            return snapshot(isSaved, reason);
        }
    }

    function recordSoon() {
        if (scheduled || !state.enabled) return;
        scheduled = true;
        locked(async () => {
            scheduled = false;
            const taken = new Map(pending);
            try {
                // A path saved again while this runs still counts as saved, here and in the next version.
                await record((rel) => pending.has(rel), 'external');
                state.error = '';
            } catch (error) {
                state.error = `Could not record a version: ${error.message}`;
                console.error('History:', error.message);
            }
            for (const [rel, count] of taken) if (pending.get(rel) === count) pending.delete(rel);
        });
    }

    // Kaleidoscope owns this repository. Reset the parts of it that could name commands or point somewhere else.
    function claim() {
        for (const name of ['config', 'objects/info/alternates', 'info/attributes']) {
            fs.rmSync(path.join(gitDir, name), { force: true });
        }
        fs.writeFileSync(path.join(gitDir, 'config'), REPO_CONFIG);
        fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
        // A workspace that is itself a Git repository should not list the history folder as new files.
        const parent = path.dirname(gitDir);
        if (path.basename(parent) === '.kaleidoscope' && !fs.existsSync(path.join(parent, '.gitignore'))) {
            fs.writeFileSync(path.join(parent, '.gitignore'), '*\n');
        }
    }

    async function open() {
        let stat = null;
        try {
            stat = fs.lstatSync(gitDir);
        } catch { /* not created yet */ }
        if (!stat) {
            fs.mkdirSync(path.dirname(gitDir), { recursive: true });
            await run(gitPath, ['init', '--bare', '-q', '--template=', '--initial-branch=main', gitDir]);
        } else if (!stat.isDirectory()) {
            throw new Error(`${gitDir} is not a folder`);
        } else if (!fs.existsSync(path.join(gitDir, 'objects')) || !fs.existsSync(path.join(gitDir, 'refs'))) {
            throw new Error(`${gitDir} exists but is not a history repository`);
        }
        if (fs.existsSync(path.join(gitDir, 'commondir'))) throw new Error(`${gitDir} is linked to another repository`);
        claim();
        loadCache();
    }

    // Check Git, open (or create) the repository, and record anything that changed while Kaleidoscope was not running.
    async function start() {
        if (!enabled) {
            state.reason = 'History is turned off (HISTORY=off)';
            return status();
        }
        if (!workspace) {
            state.reason = 'No workspace folder is configured';
            return status();
        }
        try {
            const out = (await run(gitPath, ['--version'])).toString();
            const match = out.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
            state.version = match ? match[0] : out.trim();
            if (!match || Number(match[1]) < MIN_GIT[0] || (Number(match[1]) === MIN_GIT[0] && Number(match[2]) < MIN_GIT[1])) {
                throw new Error(`Git ${MIN_GIT.join('.')} or later is needed (found ${state.version || 'an unknown version'})`);
            }
            await open();
            state.enabled = true;
            state.reason = '';
        } catch (error) {
            state.reason = error.missing
                ? 'Git was not found. Install it (macOS: xcode-select --install) or set GIT_PATH.'
                : `History could not start: ${error.message}`;
            return status();
        }
        await locked(async () => {
            try {
                await record(() => false, 'external');
            } catch (error) {
                state.error = `Could not record a version: ${error.message}`;
            }
        });
        return status();
    }

    function requireEnabled() {
        if (!state.enabled) throw new HistoryError(503, state.reason);
    }

    async function status() {
        if (!state.enabled) return { enabled: false, reason: state.reason };
        const id = await head().catch(() => null);
        const result = {
            enabled: true,
            dir: path.relative(workspace, gitDir).split(path.sep).join('/'),
            git: state.version,
            versions: 0,
            latest: null,
            busy: queued > 0,
            error: state.error
        };
        if (id) {
            const [count, latest] = await Promise.all([
                git(['rev-list', '--count', '--end-of-options', id]),
                log({ limit: 1 })
            ]);
            result.versions = Number(count.toString().trim());
            result.latest = latest.versions[0] || null;
        }
        return result;
    }

    // Versions that changed `path` (a file or a folder; '' for everything), newest first, `limit` at a time.
    // `before` continues a list after that version.
    async function log({ path: rel = '', limit = 50, before } = {}) {
        requireEnabled();
        const filter = cleanPath(rel);
        const count = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
        const from = before ? checkId(before) : await head();
        if (!from) return { versions: [], more: false };
        // --full-diff: list every file a version changed, not only those under `path`.
        const args = ['log', '--no-textconv', '--no-ext-diff', '--no-renames', '--full-diff', '--name-status', '-z',
            `--format=${LOG_FORMAT}`, `--max-count=${count + 1}`];
        if (before) args.push('--skip=1');
        args.push('--end-of-options', from, '--');
        if (filter) args.push(filter);
        let out;
        try {
            out = await git(args);
        } catch (error) {
            if (before) throw new HistoryError(404, 'Version not found');
            throw error;
        }
        const versions = parseLog(out.toString());
        return { versions: versions.slice(0, count), more: versions.length > count };
    }

    // A file as it was in a version: { content } for text, { binary, size } otherwise, { missing } if it was not there.
    async function file({ path: rel, version } = {}) {
        requireEnabled();
        const target = cleanPath(rel);
        if (!target) throw new HistoryError(400, 'Invalid path');
        checkId(version);
        let listing;
        try {
            listing = (await git(['ls-tree', '-z', '-l', '--full-tree', '--end-of-options', version, target])).toString();
        } catch {
            throw new HistoryError(404, 'Version not found');
        }
        const entry = listing.split('\0').find((line) => line.slice(line.indexOf('\t') + 1) === target);
        if (!entry) return { path: target, version, missing: true };
        const [, type, oid, size] = entry.slice(0, entry.indexOf('\t')).split(/\s+/);
        if (type !== 'blob') return { path: target, version, missing: true };
        const bytes = Number(size);
        if (bytes > MAX_TEXT_BYTES) return { path: target, version, binary: true, size: bytes };
        const content = await git(['cat-file', 'blob', oid], { maxBytes: MAX_TEXT_BYTES });
        if (content.includes(0)) return { path: target, version, binary: true, size: bytes };
        return { path: target, version, content: content.toString('utf8') };
    }

    return {
        start,
        status: async () => {
            await settled(2000);
            return status();
        },
        log: async (options) => {
            await settled(5000);
            return log(options);
        },
        file,
        // A workspace file was just saved: record a version soon (Save does not wait for it).
        saved(rel) {
            if (!state.enabled) return;
            pending.set(rel, (pending.get(rel) || 0) + 1);
            recordSoon();
        },
        // Resolves when every queued version has been recorded (for tests).
        idle: () => queue,
        get enabled() {
            return state.enabled;
        },
        get dir() {
            return gitDir;
        },
        get reason() {
            return state.reason;
        }
    };
}

module.exports = { createHistory, HistoryError, cleanPath, parseLog };
