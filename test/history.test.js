const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHistory, HistoryError, cleanPath } = require('../history');

// These run the real git in temporary folders.
const hasGit = spawnSync('git', ['--version']).status === 0;
const gitTest = (name, fn) => test(name, { skip: !hasGit && 'git is not installed' }, fn);

const INCLUDE = /\.(tex|bib|sty|cls|png|jpg|pdf)$/i;

function workspace(files = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kaleidoscope-history-')));
    for (const [rel, content] of Object.entries(files)) write(root, rel, content);
    return root;
}

function write(root, rel, content) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
}

function history(root, options = {}) {
    return createHistory({ workspace: root, include: (name) => INCLUDE.test(name), skipDirs: new Set(['node_modules']), ...options });
}

async function started(files, options) {
    const root = workspace(files);
    const h = history(root, options);
    await h.start();
    return { root, h };
}

const paths = (version) => version.files.map((f) => `${f.status} ${f.path}`).sort();

gitTest('the first version holds only the files history keeps', async () => {
    const { root, h } = await started({
        'main.tex': 'main',
        'ch/one.tex': 'one',
        'deck.pptx': 'slides',
        '.hidden.tex': 'hidden',
        'node_modules/x.tex': 'module',
        'own/.git/config': '[core]',
        'own/.gitignore': '*.png\n',
        'own/fig.png': 'png',
        'big.pdf': 'x'.repeat(2000)
    }, { maxFileBytes: 1000 });
    fs.symlinkSync(path.join(root, 'main.tex'), path.join(root, 'link.tex'));
    const { versions } = await h.log();
    assert.equal(versions.length, 1);
    assert.equal(versions[0].reason, 'first');
    assert.deepEqual(paths(versions[0]), ['A ch/one.tex', 'A main.tex', 'A own/fig.png']);
    assert.ok(fs.existsSync(path.join(root, '.kaleidoscope/history.git/objects')));
    assert.equal(fs.readFileSync(path.join(root, '.kaleidoscope/.gitignore'), 'utf8'), '*\n');
});

gitTest('a save records a version, and saving unchanged text records none', async () => {
    const { root, h } = await started({ 'main.tex': 'one' });
    write(root, 'main.tex', 'two');
    h.saved('main.tex');
    await h.idle();
    let { versions } = await h.log();
    assert.equal(versions.length, 2);
    assert.equal(versions[0].reason, 'save');
    assert.equal(versions[0].subject, 'Saved main.tex');
    assert.deepEqual(versions[0].paths, ['main.tex']);
    h.saved('main.tex');
    await h.idle();
    ({ versions } = await h.log());
    assert.equal(versions.length, 2);
});

gitTest('changes made elsewhere become their own version before the save', async () => {
    const { root, h } = await started({ 'main.tex': 'one', 'other.tex': 'a', 'gone.bib': 'b' });
    write(root, 'other.tex', 'changed in another editor');
    fs.rmSync(path.join(root, 'gone.bib'));
    write(root, 'main.tex', 'two');
    h.saved('main.tex');
    await h.idle();
    const { versions } = await h.log();
    assert.deepEqual(versions.map((v) => v.reason), ['save', 'external', 'first']);
    assert.deepEqual(paths(versions[0]), ['M main.tex']);
    assert.deepEqual(paths(versions[1]), ['D gone.bib', 'M other.tex']);
});

gitTest('changes made while Kaleidoscope was not running are recorded at the next start', async () => {
    const { root, h } = await started({ 'main.tex': 'one' });
    write(root, 'main.tex', 'edited elsewhere');
    write(root, 'new.tex', 'new');
    const again = history(root);
    const info = await again.start();
    assert.equal(info.versions, 2);
    assert.equal(info.latest.reason, 'external');
    assert.deepEqual(paths(info.latest), ['A new.tex', 'M main.tex']);
    assert.equal((await h.log()).versions.length, 2);
});

gitTest('saves in quick succession are all kept, in order', async () => {
    const { root, h } = await started({ 'main.tex': 'v0' });
    for (let i = 1; i <= 5; i++) {
        write(root, 'main.tex', `v${i}`);
        h.saved('main.tex');
    }
    await h.idle();
    const { versions } = await h.log();
    assert.ok(versions.length >= 2);
    assert.ok(versions.slice(0, -1).every((v) => v.reason === 'save'));
    assert.equal((await h.file({ path: 'main.tex', version: versions[0].id })).content, 'v5');
});

gitTest('the log filters by file and by folder, and continues after a version', async () => {
    const { root, h } = await started({ 'a/one.tex': '1', 'b/two.tex': '2' });
    for (let i = 0; i < 3; i++) {
        write(root, 'a/one.tex', `one ${i}`);
        h.saved('a/one.tex');
        await h.idle();
    }
    write(root, 'b/two.tex', 'two changed');
    h.saved('b/two.tex');
    await h.idle();
    assert.equal((await h.log({ path: 'a/one.tex' })).versions.length, 4);
    assert.equal((await h.log({ path: 'b' })).versions.length, 2);
    assert.equal((await h.log({ path: '' })).versions.length, 5);
    const first = await h.log({ path: 'a', limit: 2 });
    assert.equal(first.versions.length, 2);
    assert.equal(first.more, true);
    const rest = await h.log({ path: 'a', limit: 2, before: first.versions[1].id });
    assert.equal(rest.versions.length, 2);
    assert.equal(rest.more, false);
    assert.notEqual(rest.versions[0].id, first.versions[1].id);
});

gitTest('a file at a version comes back as text, binary or missing', async () => {
    const { root, h } = await started({ 'main.tex': 'hello', 'fig.png': Buffer.from([0x89, 0x50, 0x00, 0x01]) });
    const [first] = (await h.log()).versions;
    write(root, 'main.tex', 'hello again');
    h.saved('main.tex');
    await h.idle();
    assert.deepEqual(await h.file({ path: 'main.tex', version: first.id }), { path: 'main.tex', version: first.id, content: 'hello' });
    assert.equal((await h.file({ path: 'fig.png', version: first.id })).binary, true);
    assert.equal((await h.file({ path: 'nope.tex', version: first.id })).missing, true);
    await assert.rejects(h.file({ path: 'main.tex', version: '1'.repeat(40) }), { status: 404 });
});

test('paths and ids from the browser are checked before Git sees them', async () => {
    assert.equal(cleanPath(''), '');
    assert.equal(cleanPath('paper/main.tex'), 'paper/main.tex');
    for (const bad of ['../x.tex', 'a/../../x', '/etc/passwd', '.kaleidoscope/config', 'a/.git/config', 'a//b', 'a\nb', 7, ['a']]) {
        assert.throws(() => cleanPath(bad), HistoryError, String(bad));
    }
    if (!hasGit) return;
    const { h } = await started({ 'main.tex': 'x' });
    for (const version of ['--upload-pack=touch x', 'HEAD', 'main', 'abc', '-'.repeat(40)]) {
        await assert.rejects(h.file({ path: 'main.tex', version }), { status: 400 }, version);
    }
    await assert.rejects(h.log({ path: '../outside' }), { status: 400 });
    await assert.rejects(h.log({ before: '--all' }), { status: 400 });
});

gitTest('a planted config, attributes or hook never runs a command', async () => {
    const root = workspace({ 'main.tex': 'one', '.gitattributes': '* filter=evil diff=evil\n' });
    const marker = path.join(root, 'ran');
    const dir = path.join(root, '.kaleidoscope/history.git');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    assert.equal(spawnSync('git', ['init', '--bare', '-q', dir]).status, 0);
    fs.appendFileSync(path.join(dir, 'config'), [
        '[filter "evil"]', `\tclean = touch ${marker}-filter`, `\tprocess = touch ${marker}-process`,
        '[diff "evil"]', `\ttextconv = touch ${marker}-textconv`,
        '[core]', `\tfsmonitor = touch ${marker}-fsmonitor`, `\thooksPath = ${path.join(dir, 'hooks')}`, ''
    ].join('\n'));
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    for (const hook of ['post-commit', 'reference-transaction', 'pre-commit']) {
        fs.writeFileSync(path.join(dir, 'hooks', hook), `#!/bin/sh\ntouch ${marker}-${hook}\n`, { mode: 0o755 });
    }
    const h = history(root);
    assert.equal((await h.start()).enabled, true);
    write(root, 'main.tex', 'two');
    h.saved('main.tex');
    await h.idle();
    const { versions } = await h.log();
    await h.file({ path: 'main.tex', version: versions[0].id });
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('ran')), []);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'config'), 'utf8'), /evil|fsmonitor|hooksPath/);
});

gitTest('without Git, history is off and says why', async () => {
    const { h } = await started({ 'main.tex': 'x' }, { git: '/nonexistent/git' });
    const info = await h.status();
    assert.equal(info.enabled, false);
    assert.match(info.reason, /Git was not found/);
    await assert.rejects(h.log(), { status: 503 });
    h.saved('main.tex'); // ignored, never throws
});

test('HISTORY=off turns history off', async () => {
    const h = createHistory({ workspace: workspace(), enabled: false });
    const info = await h.start();
    assert.equal(info.enabled, false);
    assert.match(info.reason, /turned off/);
});
