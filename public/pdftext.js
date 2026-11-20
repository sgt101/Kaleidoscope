// Matching the source to the PDF by their text. SyncTeX only knows what TeX knows, and anything placed by PDF drawing commands
// (every TikZ node, for one) is somewhere else on the page than TeX thinks. The PDF's own text has true positions, down to the
// letter, so the two sides are compared directly: both are reduced to their letters and digits, and a place on one side is
// found on the other by the text around it. Used by the browser, tested in Node.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PdfText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    // Commands whose arguments are not printed text, and those where only the first argument is not.
    const NO_TEXT = new Set(['begin', 'end', 'label', 'ref', 'pageref', 'eqref', 'cite', 'citep', 'citet', 'input', 'include',
        'includegraphics', 'usepackage', 'documentclass', 'color', 'fontsize', 'vspace', 'hspace', 'setlength', 'addtolength',
        'bibliography', 'bibliographystyle', 'pagestyle', 'thispagestyle', 'definecolor', 'usetikzlibrary', 'rule', 'bgimage']);
    const FIRST_NOT_TEXT = new Set(['textcolor', 'colorbox', 'href']);
    // Text around a place, in folded characters, before and after it: as much as still matches, so noise such as coordinates
    // or the next label shortens it, one side at a time. The longest come first.
    const SIDES = [60, 30, 15, 8, 5, 3, 0];
    const WINDOWS = SIDES.flatMap((before) => SIDES.map((after) => [before, after]))
        .sort((a, b) => b[0] + b[1] - a[0] - a[1] || Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]));
    const MAX_HITS = 200;
    const NEAR = 40; // points: a click this close to text counts as on it
    const NEAREST = 4; // text items tried for one click, for those the source does not spell out

    const foldChar = (ch) => ch.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

    // The end of the group opening at `at` ({...} or [...]), or -1 if it does not close soon.
    function groupEnd(text, at) {
        const open = text[at];
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        for (let i = at; i < text.length && i < at + 2000; i++) {
            if (text[i] === '\\') i++;
            else if (text[i] === open) depth++;
            else if (text[i] === close && --depth === 0) return i + 1;
        }
        return -1;
    }

    // The printed text of LaTeX source, folded: { text, starts, ends } with where each character came from. Comments, command
    // names, options, and arguments that are not text are left out.
    function foldSource(source) {
        const out = [];
        const starts = [];
        const ends = [];
        let i = 0;
        while (i < source.length) {
            const c = source[i];
            if (c === '%') {
                const line = source.indexOf('\n', i);
                i = line === -1 ? source.length : line + 1;
            } else if (c === '\\') {
                const name = /^[A-Za-z@]+\*?/.exec(source.slice(i + 1, i + 40));
                if (!name) {
                    i += 2;
                    continue;
                }
                i += 1 + name[0].length;
                const command = name[0].replace('*', '');
                if (source[i] === '[' && command !== 'item') {
                    const end = groupEnd(source, i);
                    if (end !== -1) i = end;
                }
                if (FIRST_NOT_TEXT.has(command) && source[i] === '{') {
                    const end = groupEnd(source, i);
                    if (end !== -1) i = end;
                }
                while (NO_TEXT.has(command) && (source[i] === '{' || source[i] === '[')) {
                    const end = groupEnd(source, i);
                    if (end === -1) break;
                    i = end;
                }
            } else {
                const ch = String.fromCodePoint(source.codePointAt(i));
                for (const letter of foldChar(ch)) {
                    out.push(letter);
                    starts.push(i);
                    ends.push(i + ch.length);
                }
                i += ch.length;
            }
        }
        return { text: out.join(''), starts, ends };
    }

    // Several sources as one text to search: { text, starts, ends, pieces: [{ key, from, to }] }.
    function corpus(sources) {
        const all = { text: '', starts: [], ends: [], pieces: [] };
        for (const { key, text } of sources) {
            const folded = foldSource(text);
            const from = all.text.length;
            all.text += folded.text + '\0'; // nothing matches across files
            for (const at of folded.starts) all.starts.push(at);
            for (const at of folded.ends) all.ends.push(at);
            all.starts.push(-1);
            all.ends.push(-1);
            all.pieces.push({ key, from, to: from + folded.text.length });
        }
        return all;
    }

    // Which file and characters a match in a corpus is.
    function where(all, start, end) {
        const piece = all.pieces.find((p) => start >= p.from && start < p.to);
        return piece ? { key: piece.key, start: all.starts[start], end: all.ends[end - 1] } : null;
    }

    // The folded characters of source offsets start to end: { start, end }, empty if no printed text is there.
    function span(folded, start, end) {
        const first = (offset) => {
            let lo = 0;
            let hi = folded.starts.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (folded.starts[mid] < offset) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        };
        return { start: first(start), end: first(end) };
    }

    // The PDF's text. pages: [{ page, height, items }], items as PDF.js's getTextContent gives them.
    function index(pages) {
        const out = [];
        const itemOf = [];
        const charOf = [];
        const items = [];
        const heights = {};
        for (const { page, height, items: list } of pages) {
            heights[page] = height;
            for (const item of list) {
                if (!item.str || !item.width) continue;
                const [a, b, , , x, y] = item.transform;
                const length = Math.hypot(a, b) || 1;
                const entry = {
                    page, str: item.str, x, y, width: item.width, height: item.height || length,
                    cos: a / length, sin: b / length, first: out.length
                };
                let at = 0;
                for (const ch of item.str) {
                    for (const letter of foldChar(ch)) {
                        out.push(letter);
                        itemOf.push(items.length);
                        charOf.push(at);
                    }
                    at += ch.length;
                }
                entry.last = out.length;
                items.push(entry);
            }
        }
        return { text: out.join(''), itemOf, charOf, items, heights };
    }

    // Where characters start to end of an index are on the page: [{ page, x, y, w, h }] from the top left, one per line of text.
    function rects(pdf, start, end) {
        const found = [];
        for (let at = start; at < end;) {
            const number = pdf.itemOf[at];
            const item = pdf.items[number];
            let last = at;
            while (last + 1 < end && pdf.itemOf[last + 1] === number) last++;
            const from = pdf.charOf[at] / item.str.length;
            const to = Math.min(1, (pdf.charOf[last] + 1) / item.str.length);
            const corners = [];
            for (const along of [from * item.width, to * item.width]) {
                for (const up of [-0.25 * item.height, 0.95 * item.height]) {
                    corners.push([item.x + along * item.cos - up * item.sin, item.y + along * item.sin + up * item.cos]);
                }
            }
            const xs = corners.map((c) => c[0]);
            const ys = corners.map((c) => pdf.heights[item.page] - c[1]);
            const x = Math.min(...xs);
            const y = Math.min(...ys);
            found.push({ page: item.page, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
            at = last + 1;
        }
        return found;
    }

    // The words at and nearest a point on a page (x, y in points from the top left), closest first: [{ start, end }] in the
    // index, one from each text item, empty when no text is near.
    function wordsAt(pdf, page, x, y) {
        const fromBottom = pdf.heights[page] - y;
        const near = [];
        for (const item of pdf.items) {
            if (item.page !== page || item.first === item.last) continue;
            const dx = x - item.x;
            const dy = fromBottom - item.y;
            const along = dx * item.cos + dy * item.sin;
            const up = dy * item.cos - dx * item.sin;
            const off = Math.hypot(Math.max(0, -along, along - item.width), Math.max(0, -0.25 * item.height - up, up - item.height));
            if (off <= NEAR) near.push({ item, along, off });
        }
        return near.sort((a, b) => a.off - b.off).slice(0, NEAREST).map((hit) => wordIn(pdf, hit.item, hit.along));
    }

    // The word `along` points into a text item.
    function wordIn(pdf, item, along) {
        const inside = Math.min(0.999, Math.max(0, along / item.width));
        let at = Math.floor(inside * item.str.length);
        while (at > 0 && !foldChar(item.str[at])) at--;
        const isWord = (i) => i >= 0 && i < item.str.length && foldChar(item.str[i]);
        let from = at;
        let to = at;
        while (isWord(from - 1)) from--;
        while (isWord(to + 1)) to++;
        let start = -1;
        let end = -1;
        for (let i = item.first; i < item.last; i++) {
            if (pdf.charOf[i] >= from && pdf.charOf[i] <= to) {
                if (start === -1) start = i;
                end = i + 1;
            }
        }
        return start === -1 ? { start: item.first, end: item.last } : { start, end };
    }

    function occurrences(text, needle) {
        const hits = [];
        for (let at = text.indexOf(needle); at !== -1 && hits.length < MAX_HITS; at = text.indexOf(needle, at + 1)) hits.push(at);
        return hits;
    }

    // Find characters start to end of `from` in `to`, by as much of the text around them as `to` has: { start, end }, or
    // { hits: [...] } when more than one place fits and order cannot tell them apart, or null when none does.
    function align(from, start, end, to) {
        for (const [before, after] of WINDOWS) {
            const a = Math.max(0, start - before);
            const b = Math.min(from.length, end + after);
            const needle = from.slice(a, b);
            const hits = occurrences(to, needle);
            if (!hits.length) continue;
            const place = (at) => ({ start: at + start - a, end: at + end - a });
            if (hits.length === 1) return place(hits[0]);
            // The third of three on one side is the third on the other, if both have the same number.
            const here = occurrences(from, needle);
            if (here.length === hits.length && here.includes(a)) return place(hits[here.indexOf(a)]);
            return { hits: hits.map(place) };
        }
        return null;
    }

    return { foldSource, corpus, where, span, index, rects, wordsAt, align };
});
