const test = require('node:test');
const assert = require('node:assert/strict');
const lc = require('../public/complete');

const names = (before) => lc.suggest(lc.context(before)).map((i) => i.name);

test('typing \\c offers commands starting with c, the common ones first', () => {
    const list = names('Some text \\c');
    assert.equal(list[0], 'cite');
    assert.ok(list.every((n) => n.startsWith('c')));
});

test('a backslash alone, text, comments and line breaks offer nothing', () => {
    assert.equal(lc.context('text \\'), null);
    assert.equal(lc.context('plain cite'), null);
    assert.equal(lc.context('% a comment \\ci'), null);
    assert.equal(lc.context('line one \\\\c'), null);
    assert.notEqual(lc.context('50\\% off \\ci'), null); // an escaped % is not a comment
});

test('the context knows where the command starts', () => {
    const before = 'a\n  \\fr';
    const ctx = lc.context(before);
    assert.deepEqual(ctx, { kind: 'command', prefix: 'fr', start: before.length - 3 });
});

test('names are not offered twice', () => {
    const all = lc.COMMANDS.map((c) => c.name);
    assert.equal(new Set(all).size, all.length);
});

test('Tab on a command with an argument adds {} and puts the caret inside', () => {
    const ctx = lc.context('\\ci');
    const cite = lc.suggest(ctx)[0];
    assert.deepEqual(lc.insertion(cite, ctx, ''), { text: '\\cite{}', caret: 6, consume: 0 });
    const frac = lc.COMMANDS.find((c) => c.name === 'frac');
    assert.deepEqual(lc.insertion(frac, lc.context('\\fr'), ''), { text: '\\frac{}{}', caret: 6, consume: 0 });
});

test('a command without arguments, or already followed by braces, gets none', () => {
    const item = lc.COMMANDS.find((c) => c.name === 'item');
    assert.deepEqual(lc.insertion(item, lc.context('\\it'), ''), { text: '\\item', caret: 5, consume: 0 });
    const cite = lc.COMMANDS.find((c) => c.name === 'cite');
    assert.equal(lc.insertion(cite, lc.context('\\ci'), '{key}').text, '\\cite');
    assert.equal(lc.insertion(cite, lc.context('\\ci'), '[p. 3]{key}').text, '\\cite');
});

test('after \\begin{ the environments are offered, and the brace is closed', () => {
    const ctx = lc.context('\\begin{it');
    assert.equal(ctx.kind, 'environment');
    assert.equal(lc.suggest(ctx)[0].name, 'itemize');
    assert.deepEqual(lc.insertion(lc.suggest(ctx)[0], ctx, ''), { text: 'itemize}', caret: 8, consume: 0 });
    // an existing closing brace is replaced, not doubled
    assert.deepEqual(lc.insertion(lc.suggest(ctx)[0], ctx, '}\n'), { text: 'itemize}', caret: 8, consume: 1 });
    assert.equal(lc.context('\\end{eq').kind, 'environment');
    assert.equal(lc.suggest(lc.context('\\begin{zzz')).length, 0);
});

test('a match shows as it will be written', () => {
    const ctx = lc.context('\\fr');
    assert.equal(lc.label(lc.suggest(ctx)[0], ctx), '\\frac{}{}');
});
