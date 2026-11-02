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

    // Where `search` occurs in `doc`: { start, end } when it occurs exactly once, otherwise { error, count }. An exact
    // match is tried first; failing that, one that differs only in trailing spaces and line endings.
    function locate(doc, search) {
        if (!search || !search.trim()) return { error: 'empty', count: 0 };
        let count = 0;
        let first = -1;
        for (let at = doc.indexOf(search); at !== -1; at = doc.indexOf(search, at + 1)) {
            if (count++ === 0) first = at;
        }
        if (count === 1) return { start: first, end: first + search.length };
        if (count > 1) return { error: 'ambiguous', count };

        const wanted = search.replace(/\r/g, '').split('\n').map((line) => line.replace(/\s+$/, ''));
        const starts = [];
        let offset = 0;
        const have = doc.split('\n').map((line) => {
            starts.push(offset);
            offset += line.length + 1;
            return line.replace(/\r$/, '').replace(/\s+$/, '');
        });
        const hits = [];
        for (let i = 0; i + wanted.length <= have.length; i++) {
            if (wanted.every((line, k) => have[i + k] === line)) hits.push(i);
        }
        if (hits.length === 1) {
            const last = hits[0] + wanted.length - 1;
            const rawLast = doc.split('\n')[last];
            return { start: starts[hits[0]], end: starts[last] + rawLast.replace(/\r$/, '').length };
        }
        if (hits.length > 1) return { error: 'ambiguous', count: hits.length };
        return { error: 'missing', count: 0 };
    }

    // Apply one edit: { text, start, end } with the new document and the range the replacement occupies, or { error, count }.
    function apply(doc, edit) {
        const where = locate(doc, edit.search);
        if (where.error) return where;
        return {
            text: doc.slice(0, where.start) + edit.replace + doc.slice(where.end),
            start: where.start,
            end: where.start + edit.replace.length
        };
    }

    // The blocks of `reply` that do not fit `doc`, each applied in turn to the result of the one before:
    // [{ index, edit, error, count }].
    function check(doc, reply) {
        const failures = [];
        let current = doc;
        edits(reply).forEach((edit, index) => {
            const result = apply(current, edit);
            if (result.error) failures.push({ index, edit, error: result.error, count: result.count });
            else current = result.text;
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
