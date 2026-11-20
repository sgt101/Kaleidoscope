const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../public/pdftext');

// Text items as PDF.js gives them: a line of text at x, y (from the bottom of the page).
const item = (str, x, y, size = 10, width = str.length * 5) => ({ str, width, height: size, transform: [size, 0, 0, size, x, y] });
const pdfOf = (...pages) => T.index(pages.map((items, i) => ({ page: i + 1, height: 800, items })));

// Where a source offset range lands in a PDF, as the text there.
function forward(source, phrase, pdf, nth = 0) {
    const folded = T.foldSource(source);
    let at = -1;
    for (let i = 0; i <= nth; i++) at = source.indexOf(phrase, at + 1);
    const span = T.span(folded, at, at + phrase.length);
    return T.align(folded.text, span.start, span.end, pdf.text);
}

test('the printed text of source leaves out commands, options, comments and non-text arguments', () => {
    const text = (source) => T.foldSource(source).text;
    assert.equal(text('Hello \\textbf{bold} world.'), 'helloboldworld');
    assert.equal(text('real % not this\nnext'), 'realnext');
    assert.equal(text('50\\% off'), '50off');
    assert.equal(text('\\node[anchor=north west,inner sep=0pt] {Label}'), 'label');
    assert.equal(text('\\textcolor{cmint}{Green}'), 'green');
    assert.equal(text('\\fontsize{6.5}{7}\\selectfont Small'), 'small');
    assert.equal(text('\\includegraphics[width=7mm]{images/mark.png} Text'), 'text');
    assert.equal(text('\\begin{tabular}{ll} A & B \\end{tabular}'), 'ab');
    assert.equal(text('\\item[Term] Meaning'), 'termmeaning');
    assert.equal(text('caf\\\'e and café'), 'cafeandcafe');
    assert.equal(text('don’t -- stop'), 'dontstop');
});

test('offsets of the folded text point back at the source', () => {
    const source = 'Hello \\textbf{bold} world';
    const folded = T.foldSource(source);
    const at = folded.text.indexOf('bold');
    assert.equal(source.slice(folded.starts[at], folded.ends[at + 3]), 'bold');
    assert.deepEqual(T.span(folded, source.indexOf('bold'), source.indexOf('bold') + 4), { start: at, end: at + 4 });
    assert.deepEqual(T.span(folded, 6, 13), { start: 5, end: 5 }); // only the command: no printed text
});

test('text is found across line breaks, hyphenation, ligatures and markup', () => {
    const pdf = pdfOf([item('A good de\ufb01nition of data qual-', 100, 700), item('ity for every team.', 100, 688)]);
    const source = 'A \\emph{good} definition of\ndata quality for every team.';
    const found = forward(source, 'data quality', pdf);
    assert.equal(pdf.text.slice(found.start, found.end), 'dataquality');
    const rects = T.rects(pdf, found.start, found.end);
    assert.equal(rects.length, 2);
    assert.equal(rects[0].page, 1);
    assert.ok(rects[1].y > rects[0].y);
});

test('a phrase that repeats is told apart by the words around it', () => {
    const pdf = pdfOf([item('The first results are good.', 100, 700)], [item('The second results are bad.', 100, 700)]);
    const found = forward('The first results are good.\n\nThe second results are bad.', 'results', pdf, 1);
    assert.equal(T.rects(pdf, found.start, found.end)[0].page, 2);
});

test('identical text is matched by its order on both sides', () => {
    const pdf = pdfOf([item('Same line.', 100, 700), item('Same line.', 100, 600)], [item('Same line.', 100, 700)]);
    const found = forward('Same line.\n\nSame line.\n\nSame line.', 'Same', pdf, 2);
    assert.equal(T.rects(pdf, found.start, found.end)[0].page, 2);
});

test('when the counts differ the places are offered, and missing text gives nothing', () => {
    const pdf = pdfOf([item('Same line.', 100, 700), item('Same line.', 100, 600)]);
    assert.equal(forward('Same line.', 'Same', pdf).hits.length, 2);
    assert.equal(forward('Nothing like it', 'Nothing', pdf), null);
});

test('noise between nodes only shortens the context', () => {
    const source = '\\node at (14,9) {Alpha label};\n\\node at (30,40) {Beta label};';
    const pdf = pdfOf([item('Beta label', 300, 500), item('Alpha label', 40, 700)]);
    const found = forward(source, 'Alpha', pdf);
    assert.equal(T.rects(pdf, found.start, found.end)[0].x, 40);
});

test('a click finds the word under it, and the source of that word', () => {
    const pdf = pdfOf([item('Data quality framework', 100, 700, 10, 220)]);
    const [word] = T.wordsAt(pdf, 1, 165, 800 - 703);
    assert.equal(pdf.text.slice(word.start, word.end), 'quality');
    const source = '\\begin{pagecanvas}\n\\blk{14,22}{182mm}{Data \\textbf{quality} framework}\n\\end{pagecanvas}\n';
    const all = T.corpus([{ key: 'a.tex', text: 'Unrelated file.' }, { key: 'main.tex', text: source }]);
    const found = T.align(pdf.text, word.start, word.end, all.text);
    assert.deepEqual(T.where(all, found.start, found.end), { key: 'main.tex', start: source.indexOf('quality'), end: source.indexOf('quality') + 7 });
});

test('a short word in a short label is found by the label, not by the word alone', () => {
    const source = '\\node at (20,30) {Systems of record};\n\\node at (14,40) {Point of View};\n\\node at (10,10) {Plenty of room};';
    const pdf = pdfOf([item('Plenty of room', 100, 700), item('Point of View', 100, 600), item('Systems of record', 100, 500)]);
    const all = T.corpus([{ key: 'a', text: source }]);
    const middle = pdf.text.indexOf('pointofview') + 5;
    const found = T.align(pdf.text, middle, middle + 2, all.text);
    assert.equal(source.slice(all.starts[found.start] - 6, all.ends[found.end - 1]), 'Point of');
});

test('the nearest words come back closest first, so text the source lacks can be passed over', () => {
    const pdf = pdfOf([item('III.', 100, 700, 10, 15), item('Define the key measures', 125, 700)]);
    const words = T.wordsAt(pdf, 1, 105, 97);
    assert.equal(pdf.text.slice(words[0].start, words[0].end), 'iii');
    assert.equal(pdf.text.slice(words[1].start, words[1].end), 'define');
});

test('a click far from any text finds none, and a nearby one finds the closest', () => {
    const pdf = pdfOf([item('Label', 100, 700)]);
    assert.deepEqual(T.wordsAt(pdf, 1, 500, 500), []);
    assert.equal(T.wordsAt(pdf, 1, 90, 95).length, 1);
});

test('rotated text has an upright box and is found by a click', () => {
    const rotated = { str: 'Domain', width: 60, height: 10, transform: [0, 10, -10, 0, 100, 500] };
    const pdf = pdfOf([rotated]);
    const [rect] = T.rects(pdf, 0, 6);
    assert.ok(rect.h > rect.w);
    const [word] = T.wordsAt(pdf, 1, 96, 800 - 530);
    assert.equal(pdf.text.slice(word.start, word.end), 'domain');
});

test('a match never runs from one file into the next', () => {
    const all = T.corpus([{ key: 'a', text: 'one two' }, { key: 'b', text: 'three' }]);
    assert.equal(all.text.indexOf('twothree'), -1);
    assert.equal(T.where(all, all.text.indexOf('three'), all.text.indexOf('three') + 5).key, 'b');
});
