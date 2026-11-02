const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/edits');

const block = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

test('parse splits text and blocks', () => {
    const { segments, incomplete } = E.parse(`Fixed it.\n\n${block('a', 'b')}\n\nDone.`);
    assert.equal(incomplete, false);
    assert.deepEqual(segments.map((s) => s.type), ['text', 'edit', 'text']);
    assert.deepEqual(segments[1], { type: 'edit', search: 'a', replace: 'b' });
});

test('parse drops a code fence wrapped round a block', () => {
    const { segments } = E.parse('```latex\n' + block('x', 'y') + '\n```\nAfter');
    assert.deepEqual(segments.map((s) => s.type), ['edit', 'text']);
    assert.equal(segments[1].text, 'After');
});

test('parse keeps an unwrapped fence that follows a block', () => {
    const { segments } = E.parse(block('x', 'y') + '\n```\nmore');
    assert.equal(segments[1].text, '```\nmore');
});

test('parse strips copied line numbers from every line or none', () => {
    const numbered = E.parse(block(' 12| \\begin{x}\n 13| text', ' 12| \\begin{x}\n 13| new')).segments[0];
    assert.equal(numbered.search, '\\begin{x}\ntext');
    assert.equal(numbered.replace, '\\begin{x}\nnew');
    const mixed = E.parse(block('12| a\nb', 'c')).segments[0];
    assert.equal(mixed.search, '12| a\nb');
});

test('parse reports a block that never closes and shows it as text', () => {
    const { segments, incomplete } = E.parse('Try:\n<<<<<<< SEARCH\nabc\n=======\nxyz');
    assert.equal(incomplete, true);
    assert.equal(segments.filter((s) => s.type === 'edit').length, 0);
    assert.match(segments[0].text, /SEARCH/);
});

test('parse accepts an empty replacement (a deletion)', () => {
    const [edit] = E.edits('<<<<<<< SEARCH\nremove me\n=======\n>>>>>>> REPLACE');
    assert.equal(edit.search, 'remove me');
    assert.equal(edit.replace, '');
});

test('locate needs exactly one exact match', () => {
    const doc = 'one\ntwo\nthree\ntwo\n';
    assert.deepEqual(E.locate(doc, 'three'), { start: 8, end: 13 });
    assert.equal(E.locate(doc, 'two').error, 'ambiguous');
    assert.equal(E.locate(doc, 'zzz').error, 'missing');
    assert.equal(E.locate(doc, '   ').error, 'empty');
});

test('locate tolerates trailing spaces and CRLF', () => {
    const doc = 'a  \r\nb\t\r\nc\r\n';
    const where = E.locate(doc, 'a\nb');
    assert.equal(doc.slice(where.start, where.end), 'a  \r\nb\t');
});

test('apply returns the new text and the replaced range', () => {
    const result = E.apply('hello world', { search: 'world', replace: 'there' });
    assert.equal(result.text, 'hello there');
    assert.equal(result.start, 6);
    assert.equal(result.end, 11);
});

test('check applies blocks in turn and lists those that fail', () => {
    const reply = [block('a', 'b'), block('b', 'c'), block('nope', 'x')].join('\n');
    const failures = E.check('a', reply);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].index, 2);
    assert.equal(E.describe(failures[0]), 'does not match the file text');
});

test('diffLines drops the lines both sides share', () => {
    assert.deepEqual(E.diffLines('a\nb\nc', 'a\nB\nc'), { removed: ['b'], added: ['B'] });
    assert.deepEqual(E.diffLines('x', ''), { removed: ['x'], added: [] });
});
