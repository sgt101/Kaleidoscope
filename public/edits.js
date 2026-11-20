// Edit blocks: how the assistant proposes changes to the open file. Used by the browser (to show and apply them) and
// by the server (to check that a proposal matches the document before showing it).
//
//   <<<<<<< SEARCH
//   exact lines from the file
//   =======
//   replacement lines
//   >>>>>>> REPLACE
//
// A block applies only where its SEARCH text occurs exactly once. Nothing here touches the file: the caller decides.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.LatexEdits = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const OPEN = /^<{5,9} SEARCH\s*$/;
    const MIDDLE = /^={5,9}\s*$/;
    const CLOSE = /^>{5,9} REPLACE\s*$/;
    const FENCE = /^\s*```[\w-]*\s*$/;
    const NUMBERED = /^\s*\d+\| ?/; // the line-number prefix the assistant is shown, which it sometimes copies

    // Models copy the numbers into a block now and then; drop them when every non-empty line has one.
    function stripNumbers(lines) {
        const filled = lines.filter((line) => line.trim() !== '');
        if (!filled.length || !filled.every((line) => NUMBERED.test(line))) return lines;
        return lines.map((line) => line.replace(NUMBERED, ''));
    }

    // Split a reply into text and edit blocks: { segments: [{ type: 'text', text } | { type: 'edit', search, replace }],
    // incomplete } where `incomplete` means a block was opened and never closed (the reply was cut off).
    function parse(reply) {
        const lines = String(reply).split('\n');
        const segments = [];
        let text = [];
        let incomplete = false;
        const flush = () => {
            const joined = text.join('\n').trim();
            if (joined) segments.push({ type: 'text', text: joined });
            text = [];
        };

        for (let i = 0; i < lines.length; i++) {
            if (!OPEN.test(lines[i])) {
                text.push(lines[i]);
                continue;
            }
            const search = [];
            const replace = [];
            let target = search;
            let state = 'search';
            let j = i + 1;
            for (; j < lines.length; j++) {
                if (state === 'search' && MIDDLE.test(lines[j])) { state = 'replace'; target = replace; continue; }
                if (state === 'replace' && CLOSE.test(lines[j])) { state = 'closed'; break; }
                target.push(lines[j]);
            }
            if (state !== 'closed') {
                incomplete = true;
                text.push(...lines.slice(i)); // show what we have as plain text
                break;
            }
            // A code fence wrapped around the block is not part of the file.
            const fenced = text.length > 0 && FENCE.test(text[text.length - 1]);
            if (fenced) {
                text.pop();
                if (j + 1 < lines.length && FENCE.test(lines[j + 1])) j++;
            }
            flush();
            const numbered = stripNumbers(search);
            const strip = numbered !== search;
            segments.push({
                type: 'edit',
                search: numbered.join('\n'),
                replace: (strip ? stripNumbers(replace) : replace).join('\n')
            });
            i = j;
        }
        flush();
        return { segments, incomplete };
    }

    const edits = (reply) => parse(reply).segments.filter((segment) => segment.type === 'edit');

    function exactHits(doc, search) {
        const hits = [];
        for (let at = doc.indexOf(search); at !== -1; at = doc.indexOf(search, at + 1)) hits.push({ start: at, end: at + search.length });
        return hits;
    }

    // Whole lines that differ only in trailing spaces and line endings.
    function lineHits(doc, search) {
        const wanted = search.replace(/\r/g, '').split('\n').map((line) => line.replace(/\s+$/, ''));
        const starts = [];
        let offset = 0;
        const raw = doc.split('\n');
        const have = raw.map((line) => {
            starts.push(offset);
            offset += line.length + 1;
            return line.replace(/\r$/, '').replace(/\s+$/, '');
        });
        const hits = [];
        for (let i = 0; i + wanted.length <= have.length; i++) {
            if (!wanted.every((line, k) => have[i + k] === line)) continue;
            const last = i + wanted.length - 1;
            hits.push({ start: starts[i], end: starts[last] + raw[last].replace(/\r$/, '').length });
        }
        return hits;
    }

    // Text reduced to what a model copies reliably: every run of white space (tabs, line breaks, non-breaking spaces) is one
    // space, curly quotes are straight, every run of dashes is one hyphen, and accents are dropped. starts[i] and ends[i] are
    // the part of `text` that character i of the result came from.
    function fold(text) {
        const out = [];
        const starts = [];
        const ends = [];
        let at = 0;
        for (const ch of text) {
            const from = at;
            at += ch.length;
            let plain = ch.normalize('NFD').replace(/\p{M}/gu, '');
            if (/\s/.test(ch)) plain = ' ';
            else if (/[‘’‚‛′]/.test(ch)) plain = "'";
            else if (/[“”„‟″]/.test(ch)) plain = '"';
            else if (/[‐‑‒–—―−]/.test(ch)) plain = '-';
            const last = out[out.length - 1];
            if (!plain || ((plain === ' ' || plain === '-') && plain === last)) {
                if (out.length) ends[ends.length - 1] = at; // a mark or a longer run: part of the character before
                continue;
            }
            for (const c of plain) {
                out.push(c);
                starts.push(from);
                ends.push(at);
            }
        }
        return { text: out.join(''), starts, ends };
    }

    // Places that differ only in what fold() removes. The replaced range is the file's own text.
    function looseHits(doc, search) {
        const wanted = fold(search).text.trim();
        if (!wanted) return [];
        const folded = fold(doc);
        const hits = [];
        for (let at = folded.text.indexOf(wanted); at !== -1; at = folded.text.indexOf(wanted, at + 1)) {
            hits.push({ start: folded.starts[at], end: folded.ends[at + wanted.length - 1] });
        }
        return hits;
    }

    // Where `search` occurs in `doc`: { start, end } when it occurs exactly once, otherwise { error, count }. An exact match
    // is tried first, then ones that differ only in trailing spaces and line endings, then ones that differ in spacing,
    // quotes, dashes or accents. `near` ({ start, end }: the user's selection) picks between several places.
    function locate(doc, search, { near } = {}) {
        if (!search || !search.trim()) return { error: 'empty', count: 0 };
        let hits = exactHits(doc, search);
        if (!hits.length) hits = lineHits(doc, search);
        if (!hits.length) hits = looseHits(doc, search);
        if (hits.length > 1 && near) {
            const inside = hits.filter((hit) => hit.start < near.end && hit.end > near.start);
            if (inside.length === 1) hits = inside;
        }
        if (hits.length === 1) return hits[0];
        return hits.length ? { error: 'ambiguous', count: hits.length } : { error: 'missing', count: 0 };
    }

    // Apply one edit: { text, start, end } with the new document and the range the replacement occupies, or { error, count }.
    function apply(doc, edit, options) {
        const where = locate(doc, edit.search, options);
        if (where.error) return where;
        return {
            text: doc.slice(0, where.start) + edit.replace + doc.slice(where.end),
            start: where.start,
            end: where.start + edit.replace.length
        };
    }

    // The blocks of `reply` that do not fit `doc`: [{ index, edit, error, count }]. Each is tried on the result of the ones
    // before it, and then on `doc` itself: a model writes its blocks from the file it was shown, so an earlier block getting
    // in the way is no reason to rule one out. The user may not accept that earlier block.
    function check(doc, reply, options) {
        const failures = [];
        let current = doc;
        edits(reply).forEach((edit, index) => {
            const result = apply(current, edit, options);
            if (!result.error) {
                current = result.text;
                return;
            }
            const original = locate(doc, edit.search, options);
            if (original.error) failures.push({ index, edit, error: original.error, count: original.count });
        });
        return failures;
    }

    // The lines that change, without the lines the two sides share at either end: { removed, added }.
    function diffLines(search, replace) {
        const before = search === '' ? [] : search.split('\n');
        const after = replace === '' ? [] : replace.split('\n');
        let head = 0;
        while (head < before.length && head < after.length && before[head] === after[head]) head++;
        let tail = 0;
        while (tail < before.length - head && tail < after.length - head
            && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
        return { removed: before.slice(head, before.length - tail), added: after.slice(head, after.length - tail) };
    }

    // One sentence for a block that does not fit.
    function describe(failure) {
        if (failure.error === 'ambiguous') return `matches ${failure.count} places in the file`;
        if (failure.error === 'empty') return 'has no text to find';
        return 'does not match the file text';
    }

    return { parse, edits, locate, apply, check, diffLines, describe };
});
