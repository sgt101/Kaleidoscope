const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/diff');

const ops = (row) => row.parts.map((p) => `${p.op}${p.text}`);

test('identical texts have no rows', () => {
    assert.deepEqual(D.diff('a\nb', 'a\nb'), { identical: true, added: 0, removed: 0, rows: [] });
});

test('a changed word is marked, not the whole line', () => {
    const { rows, added, removed } = D.diff('The quick brown fox.\n', 'The slow brown fox.\n');
    assert.equal(rows[0].type, 'change');
    assert.deepEqual(ops(rows[0]), ['=The ', '-quick', '+slow', '= brown fox.']);
    assert.equal(added, 1);
    assert.equal(removed, 1);
});

test('a LaTeX command changes as one word', () => {
    const { rows } = D.diff('\\section{Intro}', '\\subsection{Intro}');
    assert.deepEqual(ops(rows[0]), ['-\\section', '+\\subsection', '={Intro}']);
    assert.deepEqual(D.tokens('\\emph{x} \\% don’t'), ['\\emph', '{', 'x', '}', ' ', '\\%', ' ', 'don’t']);
});

test('lines added or removed whole are shown as such, numbered', () => {
    let { rows } = D.diff('a\nb\nc', 'a\nc');
    assert.deepEqual(rows.map((r) => r.type), ['same', 'del', 'same']);
    assert.equal(rows[1].oldLine, 2);
    ({ rows } = D.diff('a\nc', 'a\nb\nc'));
    assert.deepEqual(rows.map((r) => [r.type, r.line]), [['same', 1], ['ins', 2], ['same', 3]]);
});

test('long unchanged stretches are collapsed around the changes', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const { rows } = D.diff(before, before.replace('line 20', 'line twenty'));
    assert.deepEqual(rows.map((r) => r.type === 'skip' ? `skip ${r.count}` : r.type),
        ['skip 17', 'same', 'same', 'same', 'change', 'same', 'same', 'same', 'skip 16']);
    assert.equal(rows[4].line, 21);
});

test('myers finds a shortest edit script', () => {
    // Edit distance (insertions + deletions) by dynamic programming, to compare against.
    const distance = (a, b) => {
        const row = Array.from({ length: b.length + 1 }, (_, j) => j);
        for (let i = 1; i <= a.length; i++) {
            let diag = row[0];
            row[0] = i;
            for (let j = 1; j <= b.length; j++) {
                const up = row[j];
                row[j] = a[i - 1] === b[j - 1] ? diag : Math.min(row[j], row[j - 1]) + 1;
                diag = up;
            }
        }
        return row[b.length];
    };
    for (let t = 0; t < 300; t++) {
        const random = () => Int32Array.from({ length: Math.floor(Math.random() * 25) }, () => Math.floor(Math.random() * 4));
        const a = random();
        const b = random();
        const out = [];
        let i = 0;
        let j = 0;
        let edits = 0;
        for (const { op, n } of D.myers(a, b)) {
            if (op === '=') out.push(...a.slice(i, i + n));
            if (op === '+') out.push(...b.slice(j, j + n));
            if (op !== '+') i += n;
            if (op !== '-') j += n;
            if (op !== '=') edits += n;
        }
        assert.deepEqual(out, [...b]);
        assert.equal(edits, distance(a, b));
    }
    assert.equal(D.myers(Int32Array.of(1, 2, 3), Int32Array.of(4, 5, 6), 2), null);
});

test('large texts stay quick, and scattered changes still line up', () => {
    const lines = Array.from({ length: 30000 }, (_, i) => `alpha ${i}`);
    let start = Date.now();
    const scattered = D.diff(lines.join('\n'), lines.map((l, i) => (i % 7 ? l : `${l} changed`)).join('\n'));
    assert.ok(Date.now() - start < 3000);
    assert.equal(scattered.removed, 0);
    assert.equal(scattered.added, Math.ceil(30000 / 7));
    start = Date.now();
    const different = D.diff(lines.join('\n'), lines.map((l) => l.replace('alpha', 'beta')).join('\n'));
    assert.ok(Date.now() - start < 3000);
    assert.equal(different.rows.length, 60000);
});
