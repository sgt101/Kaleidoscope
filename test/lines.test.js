const test = require('node:test');
const assert = require('node:assert');
const { indent, changed } = require('../public/lines');

// Apply what indent() says, returning the text with [ and ] where the selection ends up.
function press(marked, outdent = false) {
    const start = marked.indexOf('[');
    const end = marked.indexOf(']') - 1;
    const value = marked.replace('[', '').replace(']', '');
    const change = indent(value, start, end, outdent);
    if (!change) return null;
    const text = value.slice(0, change.start) + change.text + value.slice(change.end);
    return text.slice(0, change.selStart) + '[' + text.slice(change.selStart, change.selEnd) + ']' + text.slice(change.selEnd);
}

test('Tab puts a tab at the caret', () => {
    assert.strictEqual(press('ab[]cd'), 'ab\t[]cd');
    assert.strictEqual(press('[]'), '\t[]');
});

test('Tab replaces a selection within one line', () => {
    assert.strictEqual(press('a[bc]d'), 'a\t[]d');
});

test('Tab indents every line of a selection over several lines', () => {
    assert.strictEqual(press('a[b\ncd\ne]f'), '\ta[b\n\tcd\n\te]f');
});

test('Tab leaves empty lines empty', () => {
    assert.strictEqual(press('[a\n\nb]'), '[\ta\n\n\tb]');
});

test('a selection ending at the start of a line leaves that line out', () => {
    assert.strictEqual(press('[a\nb\n]c'), '[\ta\n\tb\n]c');
});

test('a selection from the very start of the file keeps a leading empty line', () => {
    assert.strictEqual(press('[\na\nb]'), '[\n\ta\n\tb]');
});

test('Shift+Tab takes a tab or up to four spaces off the line at the caret', () => {
    assert.strictEqual(press('\tab[]c', true), 'ab[]c');
    assert.strictEqual(press('      ab[]c', true), '  ab[]c');
    assert.strictEqual(press('  ab[]c', true), 'ab[]c');
});

test('Shift+Tab works on every selected line', () => {
    assert.strictEqual(press('\ta[b\n    cd\ne]f', true), 'a[b\ncd\ne]f');
});

test('Shift+Tab keeps a caret inside the removed space at the line start', () => {
    assert.strictEqual(press('\t\n  []  x', true), '\t\n[]x');
});

test('Shift+Tab with nothing to remove does nothing', () => {
    assert.strictEqual(press('ab[]c', true), null);
});

test('Shift+Tab finds the line when the caret is on a later line', () => {
    assert.strictEqual(press('a\n\tb[]\nc', true), 'a\nb[]\nc');
});

test('changed finds the lines that differ', () => {
    assert.deepStrictEqual(changed(['a', 'b', 'c'], ['a', 'x', 'c']), { start: 1, removed: 1, added: 1 });
    assert.deepStrictEqual(changed(['a', 'b'], ['a', 'x', 'y', 'b']), { start: 1, removed: 0, added: 2 });
    assert.deepStrictEqual(changed(['a', 'x', 'y', 'b'], ['a', 'b']), { start: 1, removed: 2, added: 0 });
    assert.deepStrictEqual(changed(['a', 'b'], ['a', 'b']), { start: 2, removed: 0, added: 0 });
    assert.deepStrictEqual(changed([], ['a', 'b']), { start: 0, removed: 0, added: 2 });
});

test('changed does not count a repeated line twice', () => {
    assert.deepStrictEqual(changed(['a', 'a'], ['a', 'a', 'a']), { start: 2, removed: 0, added: 1 });
});
