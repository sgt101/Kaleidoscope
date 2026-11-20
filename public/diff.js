// Word diffs for the History tab: which lines changed between two texts, and within changed lines, which words.
// Used by the browser and tested in Node. Lines are compared first; changed blocks are then compared word by word,
// where a "word" is a LaTeX command (\section), a run of letters and digits, a run of spaces, or one other character.
//
// diff(before, after) returns { identical, added, removed, rows }, where added and removed count words, and each row is
//   { type: 'same' | 'change' | 'ins', line, parts }   a line of `after` (its number), with parts [{ op, text }]
//   { type: 'del', oldLine, parts }                    a line only in `before`
//   { type: 'skip', count }                            unchanged lines left out
// and a part's op is '=' (unchanged), '-' (removed) or '+' (added).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.LatexDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const TOKEN = /\\[A-Za-z@]+\*?|\\[^A-Za-z@]|[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*|[^\S\n]+|\n|[\s\S]/gu;
    const WORDLIKE = /^(?:\\[A-Za-z@]|[\p{L}\p{N}_])/u;
    const LIMITS = { lineEdits: 2000, wordEdits: 1500, hunkTokens: 30000, context: 3 };

    const tokens = (text) => text.match(TOKEN) || [];

    // Strings to small integers, so the comparisons in myers() are cheap.
    function intern(a, b) {
        const ids = new Map();
        const map = (list) => Int32Array.from(list, (item) => {
            let id = ids.get(item);
            if (id === undefined) {
                id = ids.size;
                ids.set(item, id);
            }
            return id;
        });
        return [map(a), map(b)];
    }

    // Myers' O(ND) shortest edit script from a to b, as runs [{ op: '=' | '-' | '+', n }], or null when it would take
    // more than `limit` insertions and deletions (the caller then shows the block as removed and added whole).
    function myers(a, b, limit = Infinity) {
        const n = a.length;
        const m = b.length;
        const max = Math.min(n + m, limit);
        const off = max + 1;
        const v = new Int32Array(2 * max + 3);
        const trace = []; // trace[d]: v before step d, for k in [-d-1, d+1]
        let done = false;
        for (let d = 0; d <= max && !done; d++) {
            trace.push(v.slice(off - d - 1, off + d + 2));
            for (let k = -d; k <= d; k += 2) {
                let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
                let y = x - k;
                while (x < n && y < m && a[x] === b[y]) {
                    x++;
                    y++;
                }
                v[off + k] = x;
                if (x >= n && y >= m) {
                    done = true;
                    break;
                }
            }
        }
        if (!done) return null;

        const ops = [];
        let x = n;
        let y = m;
        for (let d = trace.length - 1; d >= 0; d--) {
            const tv = trace[d];
            const at = (k) => tv[k + d + 1];
            const k = x - y;
            const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
            const prevX = at(prevK);
            const prevY = prevX - prevK;
            while (x > prevX && y > prevY) {
                ops.push('=');
                x--;
                y--;
            }
            if (d > 0) ops.push(x === prevX ? '+' : '-');
            x = prevX;
            y = prevY;
        }
        const runs = [];
        for (let i = ops.length - 1; i >= 0; i--) {
            const last = runs[runs.length - 1];
            if (last && last.op === ops[i]) last.n++;
            else runs.push({ op: ops[i], n: 1 });
        }
        return runs;
    }

    function merge(runs) {
        const out = [];
        for (const run of runs) {
            if (!run.n) continue;
            const last = out[out.length - 1];
            if (last && last.op === run.op) last.n += run.n;
            else out.push({ ...run });
        }
        return out;
    }

    // The longest chain of [i, j] pairs (sorted by i) whose j also increases.
    function increasing(pairs) {
        const tails = [];
        const tailAt = [];
        const prev = new Int32Array(pairs.length);
        pairs.forEach(([, j], index) => {
            let lo = 0;
            let hi = tails.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (tails[mid] < j) lo = mid + 1;
                else hi = mid;
            }
            tails[lo] = j;
            tailAt[lo] = index;
            prev[index] = lo > 0 ? tailAt[lo - 1] : -1;
        });
        const chain = [];
        for (let k = tails.length ? tailAt[tails.length - 1] : -1; k !== -1; k = prev[k]) chain.push(pairs[k]);
        return chain.reverse();
    }

    // For blocks too different for myers() within its limit: items that occur once on each side are matched first
    // (as "patience diff" does), and the gaps between them are compared on their own. Null if there are none.
    function anchored(a, b, limit, depth) {
        const seen = new Map(); // item -> [count in a, count in b, index in a, index in b]
        a.forEach((item, i) => {
            const entry = seen.get(item) || [0, 0, -1, -1];
            entry[0]++;
            entry[2] = i;
            seen.set(item, entry);
        });
        b.forEach((item, j) => {
            const entry = seen.get(item);
            if (!entry) return;
            entry[1]++;
            entry[3] = j;
        });
        const pairs = [];
        for (const [inA, inB, i, j] of seen.values()) if (inA === 1 && inB === 1) pairs.push([i, j]);
        if (!pairs.length) return null;
        pairs.sort((p, q) => p[0] - q[0]);
        const runs = [];
        let i = 0;
        let j = 0;
        for (const [ai, bj] of [...increasing(pairs), [a.length, b.length]]) {
            runs.push(...align(a.subarray(i, ai), b.subarray(j, bj), limit, depth + 1));
            if (ai < a.length) runs.push({ op: '=', n: 1 });
            i = ai + 1;
            j = bj + 1;
        }
        return merge(runs);
    }

    // The edit script for two interned arrays, with the common start and end trimmed first (usually most of a document).
    function align(a, b, limit, depth = 0) {
        let head = 0;
        while (head < a.length && head < b.length && a[head] === b[head]) head++;
        let tail = 0;
        while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
        const ma = a.subarray(head, a.length - tail);
        const mb = b.subarray(head, b.length - tail);
        const middle = (ma.length && mb.length && (myers(ma, mb, limit) || (depth < 8 && anchored(ma, mb, limit, depth))))
            || [{ op: '-', n: ma.length }, { op: '+', n: mb.length }];
        return merge([{ op: '=', n: head }, ...middle, { op: '=', n: tail }]);
    }

    const script = (a, b, limit) => align(...intern(a, b), limit);

    const countWords = (list) => list.reduce((sum, token) => sum + (WORDLIKE.test(token) ? 1 : 0), 0);

    // A changed block compared word by word: rows of `after` with the removed words shown where they were.
    // Returns null when the block is too large or too different for that to be useful.
    function wordRows(oldLines, newLines, line, totals) {
        const a = tokens(oldLines.join('\n'));
        const b = tokens(newLines.join('\n'));
        if (a.length + b.length > LIMITS.hunkTokens) return null;
        const runs = script(a, b, LIMITS.wordEdits);
        if (runs.some((run) => run.op === '=') === false) return null;
        const rows = [];
        let row = { type: 'same', line, parts: [] };
        const add = (op, text) => {
            if (!text) return;
            const last = row.parts[row.parts.length - 1];
            if (last && last.op === op) last.text += text;
            else row.parts.push({ op, text });
            if (op !== '=') row.type = 'change';
        };
        let i = 0;
        let j = 0;
        for (const { op, n } of runs) {
            const list = op === '+' ? b.slice(j, j + n) : a.slice(i, i + n);
            if (op === '-') totals.removed += countWords(list);
            if (op === '+') totals.added += countWords(list);
            for (const token of list) {
                if (token === '\n' && op !== '-') {
                    rows.push(row);
                    row = { type: 'same', line: row.line + 1, parts: [] };
                } else {
                    add(op, token === '\n' ? '↵' : token);
                }
            }
            if (op !== '+') i += n;
            if (op !== '-') j += n;
        }
        rows.push(row);
        return rows;
    }

    function diff(before, after) {
        const totals = { added: 0, removed: 0 };
        if (before === after) return { identical: true, ...totals, rows: [] };
        const A = before.split('\n');
        const B = after.split('\n');
        const runs = script(A, B, LIMITS.lineEdits);

        // Blocks: unchanged lines, and changes (lines removed and lines added at the same place).
        const blocks = [];
        let i = 0;
        let j = 0;
        for (const { op, n } of runs) {
            if (op === '=') {
                blocks.push({ same: true, start: j, oldStart: i, n });
                i += n;
                j += n;
                continue;
            }
            let last = blocks[blocks.length - 1];
            if (!last || last.same) {
                last = { same: false, start: j, oldStart: i, removed: [], added: [] };
                blocks.push(last);
            }
            if (op === '-') {
                last.removed.push(...A.slice(i, i + n));
                i += n;
            } else {
                last.added.push(...B.slice(j, j + n));
                j += n;
            }
        }

        const rows = [];
        const whole = (lines, type, start) => lines.forEach((text, k) => {
            const counted = tokens(text);
            if (type === 'del') {
                totals.removed += countWords(counted);
                rows.push({ type, oldLine: start + k + 1, parts: [{ op: '-', text }] });
            } else {
                totals.added += countWords(counted);
                rows.push({ type, line: start + k + 1, parts: [{ op: '+', text }] });
            }
        });
        blocks.forEach((block, index) => {
            if (block.same) {
                // Keep a few lines either side of a change; say how many were left out.
                const keepBefore = index > 0 ? LIMITS.context : 0;
                const keepAfter = index < blocks.length - 1 ? LIMITS.context : 0;
                const show = (k) => rows.push({ type: 'same', line: block.start + k + 1, parts: [{ op: '=', text: B[block.start + k] }] });
                if (block.n <= keepBefore + keepAfter + 1) {
                    for (let k = 0; k < block.n; k++) show(k);
                    return;
                }
                for (let k = 0; k < keepBefore; k++) show(k);
                rows.push({ type: 'skip', count: block.n - keepBefore - keepAfter });
                for (let k = block.n - keepAfter; k < block.n; k++) show(k);
                return;
            }
            const words = block.removed.length && block.added.length
                ? wordRows(block.removed, block.added, block.start + 1, totals) : null;
            if (words) {
                rows.push(...words);
            } else {
                whole(block.removed, 'del', block.oldStart);
                whole(block.added, 'ins', block.start);
            }
        });
        return { identical: false, ...totals, rows };
    }

    return { diff, tokens, myers, LIMITS };
});
