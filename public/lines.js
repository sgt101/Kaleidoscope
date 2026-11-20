// Working in lines: Tab and Shift+Tab, and the numbers beside the editor. The numbers follow the text's real layout, because a
// long line wraps over several rows but has one number: a copy of each line sits over the editor, wrapping just as it does, with
// the copy's text invisible and its number showing.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.EditorLines = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const LEADING = /^(?:\t| {1,4})/;

    // Where `position` ends up after edits to the starts of lines, each { at, removed, added }.
    function shifted(position, edits) {
        return edits.reduce((moved, { at, removed, added }) => (
            position > at ? moved + added - Math.min(removed, position - at) : moved
        ), position);
    }

    // What Tab (or with `outdent`, Shift+Tab) does to `value` with start..end selected: replace start..end with text, then
    // select selStart..selEnd. Null when there is nothing to do. Tab replaces a selection within one line, as typing does;
    // over several lines it indents them all, leaving empty lines empty.
    function indent(value, start, end, outdent = false) {
        if (!outdent && !value.slice(start, end).includes('\n')) {
            return { start, end, text: '\t', selStart: start + 1, selEnd: start + 1 };
        }
        const from = start ? value.lastIndexOf('\n', start - 1) + 1 : 0;
        const last = end > start && value[end - 1] === '\n' ? end - 1 : end; // a selection ending at a line's start leaves it out
        const next = value.indexOf('\n', last);
        const to = next === -1 ? value.length : next;

        const edits = [];
        let at = from;
        const lines = value.slice(from, to).split('\n').map((line) => {
            const removed = outdent ? (LEADING.exec(line) || [''])[0].length : 0;
            const added = !outdent && line ? 1 : 0;
            if (removed || added) edits.push({ at, removed, added });
            at += line.length + 1;
            return (added ? '\t' : '') + line.slice(removed);
        });
        if (!edits.length) return null;
        return { start: from, end: to, text: lines.join('\n'), selStart: shifted(start, edits), selEnd: shifted(end, edits) };
    }

    // The run of `before` that differs from `after`: from `start`, `removed` lines go and `added` lines of `after` replace them.
    function changed(before, after) {
        const shortest = Math.min(before.length, after.length);
        let start = 0;
        while (start < shortest && before[start] === after[start]) start++;
        let same = 0;
        while (same < shortest - start && before[before.length - 1 - same] === after[after.length - 1 - same]) same++;
        return { start, removed: before.length - start - same, added: after.length - start - same };
    }

    // Keep `gutter` matching `editor`. Returns { refresh }, for when the text is set from code, which fires no event.
    function attach(editor, gutter) {
        let shown = [];

        function follow() {
            gutter.style.width = `${editor.clientWidth}px`; // leaves out the scroll bar, which the text cannot wrap into
            gutter.scrollTop = editor.scrollTop;
        }

        function refresh() {
            const lines = editor.value.split('\n');
            const { start, removed, added } = changed(shown, lines);
            for (let i = 0; i < removed; i++) gutter.children[start].remove();
            const rows = document.createDocumentFragment();
            for (const line of lines.slice(start, start + added)) {
                const row = document.createElement('div');
                row.className = 'editor-line';
                row.textContent = line;
                rows.append(row);
            }
            gutter.insertBefore(rows, gutter.children[start] || null);
            shown = lines;
            gutter.parentElement.style.setProperty('--line-digits', Math.max(2, String(lines.length).length));
            follow();
        }

        editor.addEventListener('input', refresh);
        editor.addEventListener('scroll', follow);
        new ResizeObserver(follow).observe(editor);
        refresh();
        return { refresh };
    }

    return { indent, changed, attach };
});
