// Keeping the source and the PDF together. Selecting text in the editor moves the PDF to where that text comes out and marks
// it; clicking the PDF moves the editor to the words that made that point, opening their file if need be. The text of the two
// is matched directly (pdftext.js). SyncTeX (synctex.js) separates places the text cannot, and covers what has no text.
(function () {
    const MARK_MS = 2500;
    const MARGIN = 20; // a mark this close to the edge of the pane counts as out of view

    async function getJSON(url) {
        const response = await fetch(url);
        return response.ok ? response.json() : {};
    }

    function lineAt(text, offset) {
        let line = 1;
        for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) line++;
        return line;
    }

    function lineOffsets(text, line) {
        const lines = text.split('\n');
        const index = Math.min(line, lines.length) - 1;
        const start = lines.slice(0, index).reduce((sum, part) => sum + part.length + 1, 0);
        return { start, end: start + lines[index].length };
    }

    // hooks: fileKey() the open file; sourcePath(compiledKey) its path for the server ('' for the compiled main file, null if
    // it has none); visible() whether the PDF is showing; pdf() the PDF.js document on show; keyOf(path) a workspace file's
    // key; text(key) resolves a file's current text, or null; open(key) opens a file and resolves whether it could.
    function create({ editor, preview }, hooks) {
        let compile = { id: null, key: null, pdf: null };
        let handled = ''; // the selection last acted on, or set by clicking the PDF
        let token = 0;
        let timer = null;
        let fade = null;

        function clearMarks() {
            clearTimeout(fade);
            preview.querySelectorAll('.sync-mark').forEach((mark) => mark.remove());
        }

        function show(rects) {
            clearMarks();
            const marks = [];
            for (const rect of rects) {
                const canvas = preview.querySelector(`canvas[data-page="${rect.page}"]`);
                if (!canvas) continue;
                const scale = canvas.getBoundingClientRect().width / Number(canvas.dataset.width);
                const mark = document.createElement('div');
                mark.className = 'sync-mark';
                mark.style.left = `${canvas.offsetLeft + rect.x * scale}px`;
                mark.style.top = `${canvas.offsetTop + rect.y * scale}px`;
                mark.style.width = `${rect.w * scale}px`;
                mark.style.height = `${rect.h * scale}px`;
                preview.append(mark);
                marks.push(mark);
            }
            if (!marks.length) return;
            const first = marks[0];
            const hidden = first.offsetTop < preview.scrollTop + MARGIN
                || first.offsetTop + first.offsetHeight > preview.scrollTop + preview.clientHeight - MARGIN;
            if (hidden) preview.scrollTop = first.offsetTop - preview.clientHeight / 3;
            if (first.offsetLeft < preview.scrollLeft || first.offsetLeft + first.offsetWidth > preview.scrollLeft + preview.clientWidth) {
                preview.scrollLeft = first.offsetLeft - MARGIN;
            }
            fade = setTimeout(clearMarks, MARK_MS);
        }

        // The PDF's text, read once for each compile.
        function pdfText() {
            if (!compile.pdf) {
                const document = hooks.pdf();
                compile.pdf = (async () => {
                    const pages = [];
                    for (let page = 1; page <= document.numPages; page++) {
                        const loaded = await document.getPage(page);
                        pages.push({ page, height: loaded.getViewport({ scale: 1 }).height, items: (await loaded.getTextContent()).items });
                    }
                    return PdfText.index(pages);
                })();
            }
            return compile.pdf;
        }

        // Where the editor's text from start to end comes out: rectangles on the pages.
        async function placesOf(value, start, end, path) {
            const pdf = await pdfText();
            const source = PdfText.foldSource(value);
            let span = PdfText.span(source, start, end);
            if (span.end <= span.start) {
                // Only commands or options are selected: what those lines print is what they affect.
                const first = lineOffsets(value, lineAt(value, start));
                const last = lineOffsets(value, lineAt(value, Math.max(start, end - 1)));
                span = PdfText.span(source, first.start, last.end);
            }
            const found = span.end > span.start ? PdfText.align(source.text, span.start, span.end, pdf.text) : null;
            if (found && !found.hits) return PdfText.rects(pdf, found.start, found.end);
            const params = new URLSearchParams({
                id: compile.id, path, line: lineAt(value, start), endLine: lineAt(value, end - (value[end - 1] === '\n' ? 1 : 0))
            });
            const { rects = [] } = await getJSON('/api/sync/view?' + params).catch(() => ({}));
            if (!found) return rects;
            const page = rects.length ? rects[0].page : 0;
            const places = found.hits.map((hit) => PdfText.rects(pdf, hit.start, hit.end));
            return places.find((place) => place[0].page === page) || places[0];
        }

        async function followSelection() {
            const { selectionStart: start, selectionEnd: end, value } = editor;
            const selection = `${hooks.fileKey()}:${start}:${end}`;
            if (end <= start) handled = '';
            if (end <= start || selection === handled) return;
            handled = selection;
            if (!compile.id || !hooks.visible()) return;
            const path = hooks.sourcePath(compile.key);
            if (path === null) return;
            const mine = ++token;
            const rects = await placesOf(value, start, end, path);
            if (mine === token) show(rects);
        }

        const selectionChanged = () => {
            clearTimeout(timer);
            timer = setTimeout(followSelection, 200);
        };
        for (const type of ['select', 'mouseup', 'keyup']) editor.addEventListener(type, selectionChanged);

        // Select some of the open file and bring it into view, a third of the way down the editor.
        function reveal(start, end) {
            handled = `${hooks.fileKey()}:${start}:${end}`; // this selection came from the PDF: no need to go back there
            editor.focus();
            editor.setSelectionRange(start, end);
            const top = LatexComplete.caretRect(editor, start).top - editor.getBoundingClientRect().top;
            editor.scrollTop += top - editor.clientHeight / 3;
        }

        // The files of this compile as { key, text }, the main file first.
        async function sources() {
            const { files = [] } = await getJSON('/api/sync/files?' + new URLSearchParams({ id: compile.id })).catch(() => ({}));
            const keys = [compile.key, ...files.map(hooks.keyOf).filter((key) => key !== compile.key)];
            const texts = await Promise.all(keys.map(hooks.text));
            return keys.map((key, i) => ({ key, text: texts[i] })).filter((file) => typeof file.text === 'string');
        }

        // The source of a point on a page: { key, start, end }, or { key, line } from SyncTeX alone, or null.
        async function sourceOf(page, x, y) {
            const pdf = await pdfText();
            const all = PdfText.corpus(await sources());
            // Not every word is in the source (list numbers are not), so the next nearest can stand in for it.
            const matches = PdfText.wordsAt(pdf, page, x, y).map((word) => PdfText.align(pdf.text, word.start, word.end, all.text));
            const sure = matches.find((match) => match && !match.hits);
            if (sure) return PdfText.where(all, sure.start, sure.end);
            const found = matches.find(Boolean) || null;
            const answer = await getJSON('/api/sync/edit?' + new URLSearchParams({ id: compile.id, page, x, y })).catch(() => ({}));
            const key = answer.main ? compile.key : answer.path ? hooks.keyOf(answer.path) : null;
            if (!found) return key ? { key, line: answer.line } : null;
            const places = found.hits.map((hit) => PdfText.where(all, hit.start, hit.end)).filter(Boolean);
            if (!key) return places[0] || null;
            const text = (await sources()).find((file) => file.key === key);
            const near = text ? lineOffsets(text.text, answer.line).start : 0;
            const inFile = places.filter((place) => place.key === key).sort((a, b) => Math.abs(a.start - near) - Math.abs(b.start - near));
            return inFile[0] || places[0] || null;
        }

        preview.addEventListener('click', async (e) => {
            const canvas = e.target.closest('canvas');
            if (!canvas || !compile.id) return;
            const box = canvas.getBoundingClientRect();
            const scale = box.width / Number(canvas.dataset.width);
            const found = await sourceOf(Number(canvas.dataset.page), (e.clientX - box.left) / scale, (e.clientY - box.top) / scale);
            if (!found || !await hooks.open(found.key)) return;
            const { start, end } = found.line ? lineOffsets(editor.value, found.line) : found;
            reveal(start, end);
        });

        return {
            // The PDF now showing came from `key`, with sync data `id` (null when there is none).
            compiled(id = null, key = null) {
                compile = { id, key, pdf: null };
                handled = '';
                clearMarks();
                preview.classList.toggle('syncable', Boolean(id));
            }
        };
    }

    window.PdfSync = { create };
})();
