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

test('the selection picks between several matches', () => {
    const doc = 'We see the results here.\nLater, the results again.\n';
    const second = doc.lastIndexOf('the results');
    assert.equal(E.locate(doc, 'the results').error, 'ambiguous');
    assert.deepEqual(E.locate(doc, 'the results', { near: { start: second, end: second + 11 } }), { start: second, end: second + 11 });
    assert.equal(E.locate(doc, 'the results', { near: { start: 0, end: doc.length } }).error, 'ambiguous');
    assert.deepEqual(E.check(doc, block('the results', 'our findings'), { near: { start: second, end: second + 11 } }), []);
});

test('locate forgives retyped quotes, dashes, spaces and accents, and replaces the file\'s own text', () => {
    const found = (doc, search) => {
        const where = E.locate(doc, search);
        return where.error ? where.error : doc.slice(where.start, where.end);
    };
    assert.equal(found('Kaleidoscope’s design is simple.', "Kaleidoscope's design"), 'Kaleidoscope’s design');
    assert.equal(found('He said “hello” twice.', 'He said "hello"'), 'He said “hello”');
    assert.equal(found('pages 10–20 of it', 'pages 10-20'), 'pages 10–20');
    assert.equal(found('pages 10--20 of it', 'pages 10-20'), 'pages 10--20');
    assert.equal(found('Figure\u00a01 shows it', 'Figure 1 shows'), 'Figure\u00a01 shows');
    assert.equal(found('caf\u00e9 au lait', 'cafe\u0301 au'), 'caf\u00e9 au');
    assert.equal(found('  \\item one\n  \\item two\n', '\\item one\n\\item two'), '\\item one\n  \\item two');
    assert.equal(found('\t\\item one\n\t\\item two\n', '    \\item one\n    \\item two'), '\\item one\n\t\\item two');
    assert.equal(found('The quick brown\nfox jumps over.\n', 'The quick brown fox jumps over.'), 'The quick brown\nfox jumps over.');
    assert.equal(found('alpha\nbeta\n\ngamma\n', 'beta\n\n\n'), 'beta');
    assert.equal(found('first words here  \nsecond line\n', 'words here\nsecond'), 'words here  \nsecond');
});

test('a forgiving match must still be the only one, and made-up text still fails', () => {
    assert.equal(E.locate('it’s here\nit\'s there and it’s\n', "it's  her").error, undefined);
    assert.equal(E.locate('it’s one\nit’s two\n', "it's").error, 'ambiguous');
    assert.equal(E.locate('alpha\n', 'this is not in the file').error, 'missing');
    assert.equal(E.locate('alpha\n', '  \n ').error, 'empty');
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

test('a block that fits the original file is not ruled out by an earlier block', () => {
    assert.deepEqual(E.check('x = 1\ny = 2\n', [block('x = 1', 'y = 2\nx = 1'), block('y = 2', 'y = 3')].join('\n')), []);
    assert.deepEqual(E.check('one\ntwo\nthree\n', [block('one', 'ONE'), block('one\ntwo', 'both')].join('\n')), []);
    const failures = E.check('one\n', [block('one', 'ONE'), block('nope', 'x')].join('\n'));
    assert.deepEqual(failures.map((f) => [f.index, f.error]), [[1, 'missing']]);
});

test('diffLines drops the lines both sides share', () => {
    assert.deepEqual(E.diffLines('a\nb\nc', 'a\nB\nc'), { removed: ['b'], added: ['B'] });
    assert.deepEqual(E.diffLines('x', ''), { removed: ['x'], added: [] });
});
