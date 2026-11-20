// The assistant's tasks: what the model is told, what it is shown of the editor, and the retry when a proposed edit
// does not fit the document. The model never decides what to read: the context is built here, the same way every time.
const edits = require('./public/edits');
const providers = require('./providers');

const TASKS = new Set(['ask', 'fix', 'rewrite', 'explain']);
const HISTORY_MESSAGES = 8;
const HISTORY_CHARS = 4000;

const EDIT_FORMAT = `To change the file, reply with edit blocks, each in exactly this form:

<<<<<<< SEARCH
exact lines copied from the file
=======
replacement lines
>>>>>>> REPLACE

Rules for edit blocks:
- SEARCH must match the file exactly, spacing included, and must occur once in it. Add a neighbouring line if needed to make it unique, but keep it short.
- Never put the line-number prefixes ("12| ") in a block; they are not part of the file.
- Use one block per separate change. Change only what the task needs; leave everything else as it is.
- To delete text, leave the replacement empty. Do not wrap the blocks in code fences.
- Write a sentence or two outside the blocks saying what you changed and why.
- You can edit only this one file. If a change belongs in another file, say so instead.`;

const BASE = `You are the assistant inside a LaTeX editor. You work on one file, the one the user has open, and you are shown its text with line numbers ("12| text"; the numbers are not part of the file). Be concise and exact; LaTeX users want the answer, not a lecture.`;

const TASK_PROMPTS = {
    ask: `${BASE}

Answer the user's question about LaTeX or about their document. Propose a change only when they ask for one.

${EDIT_FORMAT}`,
    fix: `${BASE}

The last compile of this file failed. Find the cause from the error and the source lines around it (the error says "l.N" for line N). Make the smallest edit that fixes it. If the cause is outside this file (a missing package, another file, a missing image), say so and do not guess an edit.

${EDIT_FORMAT}`,
    rewrite: `${BASE}

Rewrite the selected text as the user asks. Reply with a single edit block whose SEARCH is exactly the selected text, and one line saying what you did. Keep LaTeX commands, labels, citations and references intact unless the user asks otherwise.

${EDIT_FORMAT}`,
    explain: `${BASE}

Explain the selected text, or the compile error, or if neither is given the document, to someone who knows basic LaTeX. Do not propose edits and do not use edit blocks.`
};

// Added to every system prompt when the server runs in the image, which sets KALEIDOSCOPE_CONTAINER. It describes what the
// Dockerfile installs, so keep the two in step.
const CONTAINER_NOTE = `This editor and its TeX tools run inside a Docker container, not on the user's own computer, so some resources may not be available. That can be the real cause of an error:
- TeX Live 2022 is a partial install and nothing can be added while compiling. A .sty, .cls or other package file may simply be missing; such a file can be placed next to the main .tex file.
- Only open fonts are installed: Liberation, TeX Gyre, URW (such as Nimbus Sans), Carlito, Caladea, Noto, Open Sans, Roboto, Lato, Inter, EB Garamond, Linux Libertine O, Inconsolata, Fira Code, JetBrains Mono and DejaVu. Proprietary fonts and the fonts on the user's computer are not here.
- If a document names a proprietary font, that is why it cannot be found. Substitute the open font with the same letter widths, and say so: Arial -> Liberation Sans, Helvetica -> TeX Gyre Heros, Times New Roman -> Liberation Serif, Courier New -> Liberation Mono, Calibri -> Carlito, Cambria -> Caladea.
- A compile sees only the folder of the main file, so paths outside it (../ or absolute paths) cannot be read. Shell escape is off, so packages that run other programs, such as minted, fail.
When an error says a package, font, file or program cannot be found, consider this first and say so. Do not rewrite working LaTeX to hide it.`;

const DEFAULT_MESSAGES = {
    fix: 'Fix the compile error.',
    explain: 'Explain this.'
};

// ---- What the model is shown ----

const lineOf = (text, offset) => {
    let line = 1;
    for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) line++;
    return line;
};

function numbered(lines, from, to, width) {
    const out = [];
    for (let i = from; i <= to; i++) out.push(`${String(i).padStart(width)}| ${lines[i - 1]}`);
    return out;
}

function mergeRanges(ranges) {
    const sorted = ranges.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [a, b] of sorted) {
        const last = merged[merged.length - 1];
        if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
        else merged.push([a, b]);
    }
    return merged;
}

const SECTION = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?\s*(\[[^\]]*\])?\s*\{/;

// The document as numbered lines. Whole when it fits `budget` characters; otherwise the preamble, the neighbourhood of
// the selection, the cursor and the compile errors, and an outline, with the gaps marked.
function documentView(document, { selectionLines, cursorLine, errorLines, budget }) {
    const lines = document.split('\n');
    const total = lines.length;
    const width = String(total).length;
    if (document.length + total * (width + 2) <= budget) {
        return { text: numbered(lines, 1, total, width).join('\n'), partial: false, total };
    }

    const begin = lines.findIndex((line) => /\\begin\{document\}/.test(line)) + 1;
    const preamble = [1, Math.min(begin || 60, 120)];
    const focus = [];
    if (selectionLines) focus.push(selectionLines);
    for (const line of errorLines) focus.push([line, line]);
    if (!focus.length && cursorLine) focus.push([cursorLine, cursorLine]);

    let view = [];
    for (const radius of [80, 40, 15, 4]) {
        const ranges = mergeRanges([preamble, ...focus.map(([a, b]) => [Math.max(1, a - radius), Math.min(total, b + radius)])]);
        const size = ranges.reduce((sum, [a, b]) => sum + lines.slice(a - 1, b).reduce((n, line) => n + line.length + width + 3, 0), 0);
        view = ranges;
        if (size <= budget * 0.85) break;
    }

    const out = [];
    let next = 1;
    for (const [a, b] of view) {
        if (a > next) out.push(`   … (lines ${next}-${a - 1} not shown) …`);
        out.push(...numbered(lines, a, b, width));
        next = b + 1;
    }
    if (next <= total) out.push(`   … (lines ${next}-${total} not shown) …`);

    const outline = [];
    lines.forEach((line, i) => {
        const match = SECTION.exec(line);
        if (match && outline.length < 80) outline.push(`${String(i + 1).padStart(width)}| ${line.trim()}`);
    });
    return { text: out.join('\n'), partial: true, total, outline };
}

// The last compile error stays until a compile succeeds, so it can be stale or beside the point, and small models fix on it.
// Fix error and Explain always get it; a typed question gets it only when it mentions one.
const ABOUT_THE_ERROR = /\b(error|compil|fail|fix|warning|undefined)/i;
const wantsError = (task, message) => task === 'fix' || task === 'explain' || (task === 'ask' && ABOUT_THE_ERROR.test(message));

// The user message: the file, the selection, the compile error, then the request.
function buildUserMessage({ task, message, fileName, document, selStart, selEnd, cursor, compileError, budget }) {
    const error = wantsError(task, message) ? String(compileError || '') : '';
    const selection = selEnd > selStart ? document.slice(selStart, selEnd) : '';
    const selectionLines = selection ? [lineOf(document, selStart), lineOf(document, selEnd - (document[selEnd - 1] === '\n' ? 1 : 0))] : null;
    const errorLines = [...error.matchAll(/\bl\.(\d+)/g)].map((m) => Number(m[1]));
    const view = documentView(document, {
        selectionLines,
        cursorLine: cursor >= 0 ? lineOf(document, cursor) : 0,
        errorLines: errorLines.slice(0, 5),
        budget
    });

    const parts = [`File: ${fileName || '(unnamed)'}`];
    parts.push(view.partial
        ? `<document lines="${view.total}" partial="true">\n${view.text}\n</document>`
        : `<document lines="${view.total}">\n${view.text}\n</document>`);
    if (view.outline && view.outline.length) parts.push(`<outline>\n${view.outline.join('\n')}\n</outline>`);
    if (selection) {
        parts.push(`<selection lines="${selectionLines[0]}-${selectionLines[1]}">\n${selection}\n</selection>`);
    }
    if (error) parts.push(`<compile_error>\n${error}\n</compile_error>`);
    if (task === 'rewrite') parts.push('Rewrite the selection as follows.');
    parts.push(message);
    return parts.join('\n\n');
}

// ---- Thinking blocks ----
// Some local models write their reasoning inline as <think>...</think>. It is not part of the answer.
function visibleText(raw) {
    let text = raw;
    const close = text.indexOf('</think>');
    if (close !== -1 && (text.indexOf('<think>') === -1 || text.indexOf('<think>') > close)) text = text.slice(close + 8);
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    const open = text.indexOf('<think>');
    if (open !== -1) return text.slice(0, open);
    // hold back the start of a tag that may still be arriving
    for (let n = Math.min(6, text.length); n > 0; n--) {
        if ('<think>'.startsWith(text.slice(-n))) return text.slice(0, -n);
    }
    return text;
}

// ---- Running a task ----

function buildMessages(history, userMessage) {
    const past = (Array.isArray(history) ? history : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-HISTORY_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content.slice(0, HISTORY_CHARS) }));
    // Providers want the conversation to start with the user and alternate.
    while (past.length && past[0].role !== 'user') past.shift();
    const messages = [];
    for (const m of past) {
        const last = messages[messages.length - 1];
        if (last && last.role === m.role) last.content += '\n\n' + m.content;
        else messages.push(m);
    }
    if (messages.length && messages[messages.length - 1].role === 'user') messages.pop();
    messages.push({ role: 'user', content: userMessage });
    return messages;
}

function retryMessage(failures) {
    const lines = failures.map((f) => `- Block ${f.index + 1} ${edits.describe(f)}.`);
    return `Some of your edit blocks do not fit the file:\n${lines.join('\n')}\n\n`
        + 'Send the complete answer again with every block fixed. Copy SEARCH text exactly from the document above, without the line-number prefixes, and make each SEARCH occur once.';
}

const MAX_THINKING_SECONDS = 600;
const NOTES_CHARS = 60000; // of thinking passed on when time runs out, from the end

// The thinking inside a model's answer, for a model that thinks in <think> tags.
function inlineThinking(raw) {
    const open = raw.indexOf('<think>');
    if (open === -1) return '';
    const close = raw.indexOf('</think>', open);
    return raw.slice(open + 7, close === -1 ? undefined : close);
}

// The conversation again, its last message now carrying the thinking that ran out of time, so the answer can use it.
function withNotes(conversation, notes) {
    const last = conversation[conversation.length - 1];
    const note = notes.trim()
        ? `Your time to think has run out. Your thinking so far is below: answer now, using it, in the form asked for above.\n<thinking>\n${notes.trim().slice(-NOTES_CHARS)}\n</thinking>`
        : 'Your time to think has run out: answer now, in the form asked for above.';
    return [...conversation.slice(0, -1), { ...last, content: `${last.content}\n\n${note}` }];
}

// Run one task. `emit` gets { type: 'text', text } (more answer), { type: 'reset', text } (the answer so far is replaced),
// { type: 'retry', reason }, { type: 'thinking', seconds } once, when the model starts thinking before it answers (seconds:
// how long it may, 0 if there is no limit), and { type: 'thinking-over' } when that time ran out and the model is asked
// to answer from its thinking so far. `thinkingSeconds` is how long the model may think, 0 for not at all; it applies
// only to a provider with `thinking` fields, and left out, the provider's own default stands. Resolves
// { text, truncated, failures } where failures lists the edit blocks of the final answer that still do not fit the document.
async function runTask({ provider, task, message, context, history, signal, emit, env, trifle, thinkingSeconds }) {
    if (!TASKS.has(task)) task = 'ask';
    const userText = message.trim() || DEFAULT_MESSAGES[task] || '';
    const first = buildUserMessage({ ...context, task, message: userText, budget: provider.contextChars });
    let system = TASK_PROMPTS[task];
    if ((env || process.env).KALEIDOSCOPE_CONTAINER) system += `\n\n${CONTAINER_NOTE}`;
    if (provider.kind === 'trifle') {
        system += '\n\nDo not run commands, read other files, edit or create files, or start teams or plans. Reply with text and edit blocks only.';
    }
    const messages = buildMessages(history, first);
    // The selection says which place is meant when the text of a block occurs more than once.
    const options = context.selEnd > context.selStart ? { near: { start: context.selStart, end: context.selEnd } } : {};

    const limited = Boolean(provider.thinking) && Number.isInteger(thinkingSeconds);
    const limit = limited ? Math.min(Math.max(thinkingSeconds, 0), MAX_THINKING_SECONDS) : 0;

    const attempt = async (conversation, thinking = limited ? limit > 0 : undefined) => {
        let raw = '';
        let emitted = '';
        let reasoning = '';
        let started = false;
        let timeUp = false;
        let timer;
        // The request stops when the user stops it, or when the time to think is up before the answer has begun.
        const request = new AbortController();
        const stop = () => request.abort();
        if (signal?.aborted) request.abort();
        signal?.addEventListener('abort', stop, { once: true });
        const thinks = () => {
            if (started || emitted) return;
            started = true;
            const seconds = thinking && limit ? limit : 0;
            emit({ type: 'thinking', seconds });
            if (seconds) timer = setTimeout(() => { if (!emitted) { timeUp = true; request.abort(); } }, seconds * 1000);
        };
        try {
            const result = await providers.complete(provider, {
                system, messages: conversation, signal: request.signal, env, trifle, thinking,
                onThinking(delta) {
                    reasoning += delta;
                    thinks();
                },
                onText(delta) {
                    raw += delta;
                    if (raw.includes('<think>')) thinks(); // a model that thinks inside its answer
                    const visible = visibleText(raw);
                    if (visible) clearTimeout(timer);
                    if (visible.startsWith(emitted)) {
                        if (visible.length > emitted.length) emit({ type: 'text', text: visible.slice(emitted.length) });
                    } else {
                        emit({ type: 'reset', text: visible });
                    }
                    emitted = visible;
                }
            });
            return { text: visibleText(result.text).trim(), truncated: result.truncated };
        } catch (error) {
            if (!timeUp || signal?.aborted) throw error;
            emit({ type: 'thinking-over' });
            return attempt(withNotes(conversation, reasoning || inlineThinking(raw)), false);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
        }
    };

    let answer = await attempt(messages);
    let failures = task === 'explain' ? [] : edits.check(context.document, answer.text, options);
    if (failures.length && !answer.truncated) {
        emit({ type: 'retry', reason: failures.map((f) => `block ${f.index + 1} ${edits.describe(f)}`).join('; ') });
        emit({ type: 'reset', text: '' });
        answer = await attempt([...messages, { role: 'assistant', content: answer.text }, { role: 'user', content: retryMessage(failures) }]);
        failures = edits.check(context.document, answer.text, options);
    }
    return { text: answer.text, truncated: answer.truncated, failures };
}

module.exports = { TASKS, MAX_THINKING_SECONDS, runTask, buildUserMessage, buildMessages, documentView, visibleText, lineOf };
