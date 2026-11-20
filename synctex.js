// Moving between the source and the PDF. Compiles run with -synctex=1, so TeX records which source line produced each box
// on a page. The compile folder is deleted afterwards, so that record is kept here for the last few compiles, and the
// synctex program answers the two questions: where in the PDF is this line (view), and which line made this point (edit).
//
// A compile happens in a scratch folder with the main file renamed document.tex, so names are translated both ways: only
// files of the compiled project can be asked about or returned, never TeX's own files or a name from the browser.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const KEEP = 5; // compiles remembered; one for each recent PDF is plenty for one user
const MAX_LINES = 30; // lines of a selection looked up
const MAIN = 'document.tex';

// Rectangles from `synctex view`: [{ page, x, y, w, h }] in PDF points from the top left of the page. h and v are the left
// and the bottom of a box. Boxes with no size are page furniture.
function parseView(output) {
    const rects = [];
    let box = null;
    const finish = () => {
        if (box && box.W > 0 && box.H > 0) rects.push({ page: box.Page, x: box.h, y: box.v - box.H, w: box.W, h: box.H });
    };
    for (const line of output.split('\n')) {
        const match = /^(Page|h|v|W|H):(-?[\d.]+)\s*$/.exec(line);
        if (!match) continue;
        if (match[1] === 'Page') {
            finish();
            box = {};
        }
        if (box) box[match[1]] = Number(match[2]);
    }
    finish();
    return rects;
}

// The file and line from `synctex edit`: { input, line }, or null.
function parseEdit(output) {
    const input = /^Input:(.+)$/m.exec(output);
    const line = /^Line:(\d+)\s*$/m.exec(output);
    return input && line ? { input: input[1].trim(), line: Number(line[1]) } : null;
}

// Files of the project as `synctex` lists them: a name relative to the compile folder, or null for TeX's own files.
function projectFile(input, folder) {
    const prefix = [folder + '/./', folder + '/', './'].find((start) => input.startsWith(start));
    if (prefix) return path.posix.normalize(input.slice(prefix.length));
    return path.isAbsolute(input) ? null : path.posix.normalize(input);
}

// run(args, cwd) runs the synctex program and resolves { output, code }.
function createSync({ run }) {
    const compiles = new Map(); // id -> { dir, folder, mainPath, projectPath, files: Set of names in the compile folder }
    let root = null;

    function forget(id) {
        const entry = compiles.get(id);
        compiles.delete(id);
        if (entry) fs.rmSync(entry.dir, { recursive: true, force: true });
    }

    // Keep the record of a finished compile in `folder`. mainPath is the main file's workspace path, or null for a file with
    // none. Returns an id for the browser to ask with, or null if the engine wrote no record.
    function remember({ folder, mainPath = null }) {
        const source = path.join(folder, 'document.synctex.gz');
        if (!fs.existsSync(source)) return null;
        const real = fs.realpathSync(folder);
        const files = new Set();
        for (const [, input] of zlib.gunzipSync(fs.readFileSync(source)).toString('utf8').matchAll(/^Input:\d+:(.+)$/gm)) {
            const name = projectFile(input, real);
            if (name && /\.(tex|ltx|sty|cls|tikz|txt)$/i.test(name)) files.add(name);
        }
        if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaleidoscope-sync-'));
        const id = crypto.randomBytes(8).toString('hex');
        const dir = path.join(root, id);
        fs.mkdirSync(dir);
        fs.copyFileSync(source, path.join(dir, 'document.synctex.gz'));
        compiles.set(id, { dir, folder: real, mainPath, projectPath: mainPath ? path.posix.dirname(mainPath) : null, files });
        while (compiles.size > KEEP) forget(compiles.keys().next().value);
        return id;
    }

    // The name in the compile folder of a workspace file ('' is the main file), or null if it was not part of the compile.
    function inputName(entry, file) {
        if (!file || file === entry.mainPath) return MAIN;
        if (!entry.mainPath) return null;
        const name = path.posix.relative(entry.projectPath, file);
        return entry.files.has(name) ? name : null;
    }

    // Where lines `line` to `endLine` of a file appear: { rects } in page order.
    async function view({ id, path: file = '', line, endLine = line }) {
        const entry = compiles.get(id);
        const first = Number(line);
        const last = Math.min(Number(endLine), first + MAX_LINES - 1);
        if (!entry || typeof file !== 'string' || !Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) return { rects: [] };
        const name = inputName(entry, file);
        if (!name) return { rects: [] };
        const lines = Array.from({ length: last - first + 1 }, (_, i) => first + i);
        const answers = await Promise.all(lines.map((n) => run(['view', '-i', `${n}:0:${name}`, '-o', 'document.pdf'], entry.dir)));
        const seen = new Set();
        const rects = answers.flatMap(({ output }) => parseView(output)).filter((rect) => {
            const key = `${rect.page}:${rect.x}:${rect.y}:${rect.w}`;
            return !seen.has(key) && seen.add(key);
        });
        return { rects: rects.sort((a, b) => a.page - b.page || a.y - b.y) };
    }

    // The source of a point on a page: { main: true, line } for the main file, { path, line } for another workspace file,
    // or {} when it is not from a file of the project.
    async function edit({ id, page, x, y }) {
        const entry = compiles.get(id);
        const [where, left, top] = [Number(page), Number(x), Number(y)];
        if (!entry || !Number.isInteger(where) || where < 1 || !Number.isFinite(left) || !Number.isFinite(top)) return {};
        const { output } = await run(['edit', '-o', `${where}:${left}:${top}:document.pdf`], entry.dir);
        const found = parseEdit(output);
        const name = found && projectFile(found.input, entry.folder);
        if (!name) return {};
        if (name === MAIN) return { main: true, line: found.line };
        return entry.mainPath && entry.files.has(name) ? { path: path.posix.join(entry.projectPath, name), line: found.line } : {};
    }

    // The workspace paths of the project's other files in a compile: { files }.
    function files({ id }) {
        const entry = compiles.get(id);
        if (!entry || !entry.mainPath) return { files: [] };
        return { files: [...entry.files].filter((name) => name !== MAIN).map((name) => path.posix.join(entry.projectPath, name)) };
    }

    return { remember, view, edit, files };
}

module.exports = { createSync, parseView, parseEdit, projectFile };
