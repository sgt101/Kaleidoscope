const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSync, parseView, parseEdit, projectFile } = require('../synctex');

const PATH = ['/Library/TeX/texbin', process.env.PATH].join(path.delimiter);
const tools = { env: { ...process.env, PATH } };
const hasTeX = spawnSync('pdflatex', ['--version'], tools).status === 0 && spawnSync('synctex', ['help'], tools).error === undefined;
const texTest = (name, fn) => test(name, { skip: !hasTeX && 'TeX is not installed' }, fn);

const run = async (args, cwd) => {
    const result = spawnSync('synctex', args, { ...tools, cwd, encoding: 'utf8' });
    return { output: result.stdout + result.stderr, code: result.status };
};

test('parseView reads boxes and leaves out those with no size', () => {
    const output = 'SyncTeX result begin\nOutput:document.pdf\nPage:2\nx:150.5\ny:293.6\nh:133.75\nv:295.5\nW:343.5\nH:8.5\nbefore:\n'
        + 'Output:document.pdf\nPage:2\nx:1\ny:1\nh:133.75\nv:99.9\nW:343.5\nH:0.0\nSyncTeX result end\n';
    assert.deepEqual(parseView(output), [{ page: 2, x: 133.75, y: 287, w: 343.5, h: 8.5 }]);
    assert.deepEqual(parseView('SyncTeX ERROR: nothing'), []);
});

test('parseEdit reads the file and line', () => {
    assert.deepEqual(parseEdit('Output:d.pdf\nInput:/tmp/x/./chapter.tex\nLine:12\nColumn:-1\n'), { input: '/tmp/x/./chapter.tex', line: 12 });
    assert.equal(parseEdit('no result'), null);
});

test('projectFile keeps files of the compile folder only', () => {
    assert.equal(projectFile('/tmp/x/./sub/a.tex', '/tmp/x'), 'sub/a.tex');
    assert.equal(projectFile('/tmp/x/document.tex', '/tmp/x'), 'document.tex');
    assert.equal(projectFile('./a.tex', '/tmp/x'), 'a.tex');
    assert.equal(projectFile('/usr/share/texlive/article.cls', '/tmp/x'), null);
});

function compile(main) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kaleidoscope-synctest-'));
    fs.mkdirSync(path.join(folder, 'sub'));
    fs.writeFileSync(path.join(folder, 'document.tex'), main);
    fs.writeFileSync(path.join(folder, 'sub', 'chapter.tex'), '\\section{Chapter}\nA chapter from another file.\n');
    const result = spawnSync('pdflatex', ['-interaction=nonstopmode', '-synctex=1', 'document.tex'], { ...tools, cwd: folder });
    assert.equal(result.status, 0);
    return folder;
}

const MAIN = '\\documentclass{article}\n\\begin{document}\nFirst page text.\n\\input{sub/chapter}\n\\newpage\nSecond page text.\n\\end{document}\n';

texTest('source lines and PDF points map to each other, across files and pages', async () => {
    const sync = createSync({ run });
    const id = sync.remember({ folder: compile(MAIN), mainPath: 'paper/main.tex' });

    const second = await sync.view({ id, path: 'paper/main.tex', line: 6 });
    assert.equal(second.rects[0].page, 2);
    const box = second.rects[0];
    assert.deepEqual(await sync.edit({ id, page: 2, x: box.x + 5, y: box.y + box.h / 2 }), { main: true, line: 6 });

    const chapter = await sync.view({ id, path: 'paper/sub/chapter.tex', line: 2 });
    assert.equal(chapter.rects[0].page, 1);
    const inside = chapter.rects[0];
    assert.deepEqual(await sync.edit({ id, page: 1, x: inside.x + 5, y: inside.y + inside.h / 2 }), { path: 'paper/sub/chapter.tex', line: 2 });
});

texTest('a selection of several lines gives their boxes in page order', async () => {
    const sync = createSync({ run });
    const id = sync.remember({ folder: compile(MAIN), mainPath: 'main.tex' });
    const { rects } = await sync.view({ id, path: 'main.tex', line: 3, endLine: 6 });
    assert.ok(rects.length >= 2);
    assert.deepEqual(rects.map((r) => r.page), [...rects.map((r) => r.page)].sort());
    assert.equal(rects[rects.length - 1].page, 2);
});

texTest('a file with no workspace path is the main file, and other files are not offered', async () => {
    const sync = createSync({ run });
    const id = sync.remember({ folder: compile(MAIN), mainPath: null });
    assert.equal((await sync.view({ id, line: 3 })).rects[0].page, 1);
    assert.deepEqual(await sync.view({ id, path: 'sub/chapter.tex', line: 1 }), { rects: [] });
});

texTest('the other files of a compile are listed by workspace path', () => {
    const sync = createSync({ run });
    const id = sync.remember({ folder: compile(MAIN), mainPath: 'paper/main.tex' });
    assert.deepEqual(sync.files({ id }), { files: ['paper/sub/chapter.tex'] });
    assert.deepEqual(sync.files({ id: 'nope' }), { files: [] });
});

texTest('only files of the compile can be asked about, and bad input gets no answer', async () => {
    let calls = 0;
    const sync = createSync({ run: (args, cwd) => { calls++; return run(args, cwd); } });
    const id = sync.remember({ folder: compile(MAIN), mainPath: 'paper/main.tex' });
    for (const query of [
        { id: 'nope', line: 3 },
        { id, path: 'paper/../../etc/passwd', line: 1 },
        { id, path: 'paper/other.tex', line: 1 },
        { id, line: 0 },
        { id, line: '3;rm' },
        { id, line: 5, endLine: 2 },
        { id, path: ['x'], line: 1 }
    ]) assert.deepEqual(await sync.view(query), { rects: [] }, JSON.stringify(query));
    for (const query of [{ id: 'nope', page: 1, x: 1, y: 1 }, { id, page: 0, x: 1, y: 1 }, { id, page: 1, x: 'a', y: 1 }, { id, page: '1:2', x: 1, y: 1 }]) {
        assert.deepEqual(await sync.edit(query), {}, JSON.stringify(query));
    }
    assert.equal(calls, 0);
});

texTest('only the last few compiles are kept', () => {
    const sync = createSync({ run });
    const folder = compile(MAIN);
    const ids = Array.from({ length: 7 }, () => sync.remember({ folder, mainPath: 'main.tex' }));
    return Promise.all([sync.view({ id: ids[0], path: 'main.tex', line: 3 }), sync.view({ id: ids[6], path: 'main.tex', line: 3 })]).then(([old, recent]) => {
        assert.deepEqual(old, { rects: [] });
        assert.ok(recent.rects.length > 0);
    });
});

test('a compile with no record has no id', () => {
    const sync = createSync({ run });
    assert.equal(sync.remember({ folder: fs.mkdtempSync(path.join(os.tmpdir(), 'kaleidoscope-synctest-')) }), null);
});
