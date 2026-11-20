const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const providers = require('../providers');
const assistant = require('../assistant');

// A model server that records requests and answers with the scripted text for each, as server-sent events.
function mockServer(kind, answers) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const parsed = body ? JSON.parse(body) : {};
            requests.push({ url: req.url, headers: req.headers, body: parsed });
            const next = answers.shift();
            if (typeof next === 'number') { res.writeHead(next, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'nope' } })); }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const parts = next.match(/[\s\S]{1,7}/g) || [];
            if (kind === 'anthropic') {
                for (const p of parts) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: p } })}\n\n`);
                res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`);
            } else {
                for (const p of parts) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
            }
            res.end();
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close()
    })));
}

const make = (extra) => providers.normalise({ id: 'm', kind: 'openai', model: 'mm', ...extra }, 0);
const block = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

test('openai provider streams text and sends the key', async () => {
    const mock = await mockServer('openai', ['hello streaming world']);
    try {
        const provider = make({ url: mock.url + '/v1', keyEnv: 'TEST_KEY' });
        const seen = [];
        const result = await providers.complete(provider, {
            system: 'SYS', messages: [{ role: 'user', content: 'hi' }], env: { TEST_KEY: 'sekret' }, onText: (t) => seen.push(t)
        });
        assert.equal(result.text, 'hello streaming world');
        assert.ok(seen.length > 1);
        assert.equal(mock.requests[0].url, '/v1/chat/completions');
        assert.equal(mock.requests[0].headers.authorization, 'Bearer sekret');
        assert.deepEqual(mock.requests[0].body.messages[0], { role: 'system', content: 'SYS' });
        assert.equal(mock.requests[0].body.stream, true);
    } finally { mock.close(); }
});

test('extraBody fields go into each request, and temperature still wins', async () => {
    const mock = await mockServer('openai', ['thought it over']);
    try {
        const provider = make({ url: mock.url + '/v1', temperature: 0.2, extraBody: { enable_thinking: true, top_k: 20, temperature: 1 } });
        await providers.complete(provider, { system: 'SYS', messages: [{ role: 'user', content: 'hi' }] });
        const sent = mock.requests[0].body;
        assert.equal(sent.enable_thinking, true);
        assert.equal(sent.top_k, 20);
        assert.equal(sent.temperature, 0.2);
        assert.equal(sent.model, 'mm');
        assert.equal(sent.stream, true);
    } finally { mock.close(); }
});

test('extraBody must be an object, and cannot set what Kaleidoscope sets', () => {
    assert.deepEqual(make({ url: 'http://x/v1' }).extraBody, {});
    assert.throws(() => make({ url: 'http://x/v1', extraBody: [1] }), /extraBody must be an object/);
    assert.throws(() => make({ url: 'http://x/v1', extraBody: 'thinking' }), /extraBody must be an object/);
    assert.throws(() => make({ url: 'http://x/v1', extraBody: { stream: false, model: 'y' } }), /cannot set stream, model/);
});

test('anthropic provider puts the system prompt at the top level', async () => {
    const mock = await mockServer('anthropic', ['claude says hi']);
    try {
        const provider = make({ kind: 'anthropic', url: mock.url, keyEnv: 'TEST_KEY' });
        const result = await providers.complete(provider, { system: 'SYS', messages: [{ role: 'user', content: 'hi' }], env: { TEST_KEY: 'k' } });
        assert.equal(result.text, 'claude says hi');
        assert.equal(mock.requests[0].url, '/v1/messages');
        assert.equal(mock.requests[0].headers['x-api-key'], 'k');
        assert.equal(mock.requests[0].headers['anthropic-version'], '2023-06-01');
        assert.equal(mock.requests[0].body.system, 'SYS');
        assert.ok(mock.requests[0].body.max_tokens > 0);
    } finally { mock.close(); }
});

test('errors say what went wrong', async () => {
    const mock = await mockServer('openai', [401]);
    try {
        const provider = make({ url: mock.url + '/v1', keyEnv: 'TEST_KEY', label: 'Hosted' });
        await assert.rejects(providers.complete(provider, { system: 's', messages: [{ role: 'user', content: 'x' }], env: { TEST_KEY: 'bad' } }), /Hosted rejected the API key/);
        await assert.rejects(providers.complete(provider, { system: 's', messages: [], env: {} }), /TEST_KEY is not set/);
    } finally { mock.close(); }
    const dead = make({ url: 'http://127.0.0.1:9/v1', label: 'MLX' });
    await assert.rejects(providers.complete(dead, { system: 's', messages: [{ role: 'user', content: 'x' }] }), /Cannot reach MLX.*server running/);
});

test('abort stops the request', async () => {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const controller = new AbortController();
        const provider = make({ url: `http://127.0.0.1:${server.address().port}/v1` });
        const run = providers.complete(provider, { system: 's', messages: [{ role: 'user', content: 'x' }], signal: controller.signal, onText: () => controller.abort() });
        await assert.rejects(run, (e) => e.name === 'AbortError' || /abort/i.test(e.message));
    } finally { server.closeAllConnections(); server.close(); }
});

test('a silent model is given up on', async () => {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const provider = make({ url: `http://127.0.0.1:${server.address().port}/v1`, label: 'Slow' });
        provider.idleMs = 150;
        await assert.rejects(providers.complete(provider, { system: 's', messages: [{ role: 'user', content: 'x' }] }), /Slow stopped answering/);
    } finally { server.closeAllConnections(); server.close(); }
});

const DOC = '\\documentclass{article}\n\\begin{document}\nHello wrold.\n\\end{document}';

test('runTask sends numbered context and the compile error', async () => {
    const mock = await mockServer('openai', ['Because of a typo.\n' + block('Hello wrold.', 'Hello world.')]);
    try {
        const provider = make({ url: mock.url + '/v1' });
        const events = [];
        const result = await assistant.runTask({
            provider, task: 'fix', message: '', history: [],
            context: { fileName: 'main.tex', document: DOC, selStart: 0, selEnd: 0, cursor: -1, compileError: '! Undefined control sequence.\nl.3 Hello wrold.' },
            emit: (e) => events.push(e)
        });
        const sent = mock.requests[0].body.messages;
        assert.match(sent[0].content, /compile of this file failed/);
        const user = sent[sent.length - 1].content;
        assert.match(user, /3\| Hello wrold\./);
        assert.match(user, /<compile_error>/);
        assert.match(user, /Fix the compile error\./);
        assert.equal(result.failures.length, 0);
        assert.equal(result.text.includes('SEARCH'), true);
        assert.ok(events.some((e) => e.type === 'text'));
    } finally { mock.close(); }
});

test('every system prompt mentions the container, but only when the server runs in one', async () => {
    const system = async (task, env) => {
        const mock = await mockServer('openai', ['An answer.']);
        try {
            await assistant.runTask({
                provider: make({ url: mock.url + '/v1' }), task, message: 'hi', history: [], env,
                context: { fileName: 'main.tex', document: DOC, selStart: 0, selEnd: 5, cursor: -1, compileError: '' },
                emit: () => {}
            });
            return mock.requests[0].body.messages[0].content;
        } finally { mock.close(); }
    };
    for (const task of assistant.TASKS) {
        const note = await system(task, { KALEIDOSCOPE_CONTAINER: '1' });
        assert.match(note, /inside a Docker container.*real cause of an error/s, task);
        assert.match(note, /Arial -> Liberation Sans, Helvetica -> TeX Gyre Heros/, task);
        assert.doesNotMatch(await system(task, {}), /Docker/, task);
    }
});

test('rewriting a phrase that also occurs elsewhere fits, because the selection says which one', async () => {
    const document = 'We see the results here.\nLater, the results again.\n';
    const start = document.lastIndexOf('the results');
    const mock = await mockServer('openai', ['Done.\n' + block('the results', 'our findings')]);
    try {
        const result = await assistant.runTask({
            provider: make({ url: mock.url + '/v1' }), task: 'rewrite', message: 'better', history: [],
            context: { fileName: 'main.tex', document, selStart: start, selEnd: start + 11, cursor: -1, compileError: '' },
            emit: () => {}
        });
        assert.deepEqual(result.failures, []);
        assert.equal(mock.requests.length, 1);
    } finally { mock.close(); }
});

// A server that streams `events` (the deltas of one answer) as server-sent events.
function streaming(kind, events) {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            for (const delta of events) {
                res.write(`data: ${JSON.stringify(kind === 'anthropic' ? { type: 'content_block_delta', delta } : { choices: [{ delta }] })}\n\n`);
            }
            res.end(kind === 'anthropic' ? '' : 'data: [DONE]\n\n');
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const thinkingEvents = async (kind, deltas) => {
    const server = await streaming(kind, deltas);
    try {
        const events = [];
        const provider = kind === 'anthropic' ? make({ kind, url: server.url }) : make({ url: server.url + '/v1' });
        const result = await assistant.runTask({
            provider, task: 'explain', message: 'why', history: [],
            context: { fileName: 'a.tex', document: DOC, selStart: 0, selEnd: 0, cursor: -1, compileError: '' },
            emit: (e) => events.push(e)
        });
        return { result, types: events.map((e) => e.type) };
    } finally { server.close(); }
};

test('a model that thinks first is reported thinking once, before its answer', async () => {
    const separate = await thinkingEvents('openai', [{ reasoning_content: 'Let me ' }, { reasoning_content: 'see.' }, { content: 'It is ' }, { content: 'fine.' }]);
    assert.deepEqual(separate.types, ['thinking', 'text', 'text']);
    assert.equal(separate.result.text, 'It is fine.');

    const inline = await thinkingEvents('openai', [{ content: '<think>Let me' }, { content: ' see.</think>' }, { content: 'It is fine.' }]);
    assert.deepEqual(inline.types, ['thinking', 'text']);
    assert.equal(inline.result.text, 'It is fine.');

    const claude = await thinkingEvents('anthropic', [{ type: 'thinking_delta', thinking: 'Hmm.' }, { type: 'text_delta', text: 'It is fine.' }]);
    assert.deepEqual(claude.types, ['thinking', 'text']);

    const plain = await thinkingEvents('openai', [{ content: 'It is fine.' }]);
    assert.deepEqual(plain.types, ['text']);
});

const THINKING = { on: { enable_thinking: true, top_k: 20 }, off: { enable_thinking: false } };

test('thinking must be { on, off } request fields', () => {
    assert.equal(make({ url: 'http://x/v1' }).thinking, null);
    assert.deepEqual(make({ url: 'http://x/v1', thinking: THINKING }).thinking, THINKING);
    assert.throws(() => make({ url: 'http://x/v1', thinking: true }), /thinking must be/);
    assert.throws(() => make({ url: 'http://x/v1', thinking: { on: { model: 'x' } } }), /thinking.on cannot set model/);
});

// A server that thinks for as long as it is let, unless asked not to think, when it answers at once. Records each request.
function thinker() {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const sent = JSON.parse(body);
            requests.push(sent);
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
            if (sent.enable_thinking === false) {
                send({ content: 'The answer.' });
                return res.end('data: [DONE]\n\n');
            }
            const pulse = setInterval(() => send({ reasoning_content: 'still thinking. ' }), 50);
            res.on('close', () => clearInterval(pulse));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => { server.closeAllConnections(); server.close(); }
    })));
}

const runThinking = (provider, thinkingSeconds, events) => assistant.runTask({
    provider, task: 'explain', message: 'why', history: [], thinkingSeconds,
    context: { fileName: 'a.tex', document: DOC, selStart: 0, selEnd: 0, cursor: -1, compileError: '' },
    emit: (e) => events.push(e)
});

test('when the time to think runs out, the model is asked to answer from its thinking so far', async () => {
    const server = await thinker();
    try {
        const events = [];
        const started = Date.now();
        const result = await runThinking(make({ url: server.url, thinking: THINKING }), 1, events);
        assert.ok(Date.now() - started < 5000);
        assert.equal(result.text, 'The answer.');
        assert.deepEqual(events.map((e) => e.type), ['thinking', 'thinking-over', 'text']);
        assert.equal(events[0].seconds, 1);
        assert.equal(server.requests[0].enable_thinking, true);
        assert.equal(server.requests[0].top_k, 20);
        assert.equal(server.requests[1].enable_thinking, false);
        const last = server.requests[1].messages.at(-1).content;
        assert.match(last, /time to think has run out[\s\S]*<thinking>\nstill thinking\./);
    } finally { server.close(); }
});

test('thinking set to 0 asks the model not to think, and a provider without thinking fields is sent neither', async () => {
    const server = await thinker();
    try {
        const events = [];
        assert.equal((await runThinking(make({ url: server.url, thinking: THINKING }), 0, events)).text, 'The answer.');
        assert.equal(server.requests[0].enable_thinking, false);
        assert.deepEqual(events.map((e) => e.type), ['text']);
    } finally { server.close(); }

    const plain = await mockServer('openai', ['fine']);
    try {
        await runThinking(make({ url: plain.url + '/v1' }), 120, []);
        assert.ok(!('enable_thinking' in plain.requests[0].body));
    } finally { plain.close(); }
});

test('Stop during thinking stops it, without asking for an answer', async () => {
    const server = await thinker();
    try {
        const controller = new AbortController();
        const events = [];
        const run = assistant.runTask({
            provider: make({ url: server.url, thinking: THINKING }), task: 'explain', message: 'why', history: [], thinkingSeconds: 1,
            context: { fileName: 'a.tex', document: DOC, selStart: 0, selEnd: 0, cursor: -1, compileError: '' },
            emit: (e) => { events.push(e); if (e.type === 'thinking') setTimeout(() => controller.abort(), 100); },
            signal: controller.signal
        });
        await assert.rejects(run);
        assert.equal(server.requests.length, 1);
        assert.ok(!events.some((e) => e.type === 'thinking-over'));
    } finally { server.close(); }
});

test('a block that does not fit is sent back once, and the retry is used', async () => {
    const mock = await mockServer('openai', [block('Hello wrld.', 'Hello world.'), block('Hello wrold.', 'Hello world.')]);
    try {
        const events = [];
        const result = await assistant.runTask({
            provider: make({ url: mock.url + '/v1' }), task: 'ask', message: 'fix the typo', history: [],
            context: { fileName: 'a.tex', document: DOC, selStart: 0, selEnd: 0, cursor: -1, compileError: '' },
            emit: (e) => events.push(e)
        });
        assert.equal(mock.requests.length, 2);
        const retry = mock.requests[1].body.messages;
        assert.equal(retry[retry.length - 1].role, 'user');
        assert.match(retry[retry.length - 1].content, /Block 1 does not match the file text/);
        assert.equal(result.failures.length, 0);
        assert.deepEqual(events.filter((e) => e.type === 'retry').length, 1);
    } finally { mock.close(); }
});

test('only one retry, then the remaining failures are reported', async () => {
    const mock = await mockServer('openai', [block('no', 'x'), block('still no', 'y')]);
    try {
        const result = await assistant.runTask({
            provider: make({ url: mock.url + '/v1' }), task: 'ask', message: 'change something', history: [],
            context: { fileName: 'a.tex', document: DOC, selStart: 0, selEnd: 0, cursor: -1, compileError: '' }, emit: () => {}
        });
        assert.equal(mock.requests.length, 2);
        assert.equal(result.failures.length, 1);
    } finally { mock.close(); }
});

test('explain never asks for edits and gets no retry', async () => {
    const mock = await mockServer('openai', ['It is a title. ' + block('zzz', 'y')]);
    try {
        const result = await assistant.runTask({
            provider: make({ url: mock.url + '/v1' }), task: 'explain', message: '', history: [],
            context: { fileName: 'a.tex', document: DOC, selStart: 0, selEnd: 23, cursor: -1, compileError: '' }, emit: () => {}
        });
        assert.equal(mock.requests.length, 1);
        assert.match(mock.requests[0].body.messages[0].content, /Do not propose edits/);
        assert.match(mock.requests[0].body.messages.at(-1).content, /<selection lines="1-1">\n\\documentclass\{article\}\n<\/selection>/);
        assert.equal(result.failures.length, 0);
    } finally { mock.close(); }
});

test('thinking blocks are not shown', async () => {
    assert.equal(assistant.visibleText('<think>hmm</think>Answer'), 'Answer');
    assert.equal(assistant.visibleText('<think>still thinking'), '');
    assert.equal(assistant.visibleText('Answer <thi'), 'Answer ');
    assert.equal(assistant.visibleText('thoughts</think>Answer'), 'Answer');
    assert.equal(assistant.visibleText('a < b and <b>'), 'a < b and <b>');
});

test('history alternates and ends with the new request', () => {
    const messages = assistant.buildMessages([
        { role: 'assistant', content: 'stray' }, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }
    ], 'NOW');
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(messages.at(-1).content, 'NOW');
});

test('the last compile error goes only with requests it matters to', () => {
    const message = (task, text) => assistant.buildUserMessage({
        task, message: text, fileName: 'a.tex', document: DOC, selStart: 0, selEnd: 0, cursor: -1,
        compileError: '! Undefined control sequence.\nl.3 Hello wrold.', budget: 32000
    });
    assert.match(message('fix', 'Fix the compile error.'), /<compile_error>/);
    assert.match(message('explain', 'Explain this.'), /<compile_error>/);
    for (const text of ['Why did the compile fail?', 'What does this error mean?', 'Why won\'t it compile', 'Any warnings?', 'undefined control sequence?', 'can you fix it']) {
        assert.match(message('ask', text), /<compile_error>/, text);
    }
    for (const text of ['Can you tighten the abstract?', 'Suggest a better title', 'prefix this with a note']) {
        assert.doesNotMatch(message('ask', text), /<compile_error>/, text);
    }
    assert.doesNotMatch(message('rewrite', 'Shorter'), /<compile_error>/);
});

test('an error left out does not choose which parts of a long file are shown', () => {
    const document = Array.from({ length: 4000 }, (_, i) => (i === 0 ? '\\documentclass{article}' : i === 4 ? '\\begin{document}' : `line ${i + 1}`)).join('\n');
    const message = (text) => assistant.buildUserMessage({
        task: 'ask', message: text, fileName: 'a.tex', document, selStart: 0, selEnd: 0, cursor: -1, compileError: '! Oops.\nl.2500 line', budget: 8000
    });
    assert.match(message('What is this error?'), /2500\| line 2500/);
    assert.doesNotMatch(message('Tighten the abstract'), /2500\| line 2500/);
});

test('a long document is cut down around the error and the selection', () => {
    const lines = Array.from({ length: 4000 }, (_, i) => (i === 0 ? '\\documentclass{article}' : i === 4 ? '\\begin{document}' : i % 500 === 0 ? `\\section{Part ${i}}` : `line ${i + 1} text text text text`));
    const document = lines.join('\n');
    const view = assistant.documentView(document, { selectionLines: null, cursorLine: 0, errorLines: [2500], budget: 8000 });
    assert.equal(view.partial, true);
    assert.ok(view.text.length < 9000, 'fits the budget: ' + view.text.length);
    assert.match(view.text, /2500\| line 2500/);
    assert.match(view.text, /not shown/);
    assert.match(view.text, /1\| \\documentclass/);
    assert.ok(view.outline.length > 3);
});

test('loadProviders: built-ins, file, and mistakes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
    try {
        const builtin = providers.loadProviders({ ANTHROPIC_API_KEY: 'x' }, { dir });
        assert.deepEqual(builtin.providers.map((p) => p.id), ['mlx', 'claude']);
        assert.equal(builtin.providers[0].local, true);
        assert.equal(builtin.providers[1].local, false);
        assert.equal(builtin.providers[1].host, 'api.anthropic.com');

        fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ default: 'b', providers: [
            { id: 'a', kind: 'openai', url: 'http://host.docker.internal:8081/v1', model: 'm' },
            { id: 'b', kind: 'anthropic', model: 'claude-x', keyEnv: 'K' }] }));
        const fromFile = providers.loadProviders({}, { dir });
        assert.equal(fromFile.preferred, 'b');
        assert.equal(fromFile.providers[0].local, true);

        fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify([{ id: 'a', kind: 'openai', model: 'm' }]));
        assert.throws(() => providers.loadProviders({}, { dir }), /url is required/);
        fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify([{ id: 'a', kind: 'nope', model: 'm' }]));
        assert.throws(() => providers.loadProviders({}, { dir }), /kind must be/);
        fs.writeFileSync(path.join(dir, 'providers.json'), '{ not json');
        assert.throws(() => providers.loadProviders({}, { dir }), /not valid JSON/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('listModels reads the model names a server offers', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mlx-community/b' }, { id: 'mlx-community/a' }, { id: 'mlx-community/a' }, {}] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        const names = await providers.listModels(make({ url: url + '/v1', keyEnv: 'K' }), { env: { K: 'sekret' } });
        assert.deepEqual(names, ['mlx-community/a', 'mlx-community/b']);
        assert.equal(seen[0].url, '/v1/models');
        assert.equal(seen[0].auth, 'Bearer sekret');

        const claude = providers.normalise({ id: 'c', kind: 'anthropic', model: 'x', url, keyEnv: 'K' }, 0);
        await providers.listModels(claude, { env: { K: 'sekret' } });
        assert.equal(seen[1].url, '/v1/models?limit=100');
        assert.equal(seen[1].key, 'sekret');

        // a hosted provider without its key is not asked
        assert.deepEqual(await providers.listModels(claude, { env: {} }), []);
        assert.equal(seen.length, 2);
    } finally { server.close(); }
    // nothing listening: an empty list, not an error
    assert.deepEqual(await providers.listModels(make({ url: 'http://127.0.0.1:1/v1' })), []);
});

test('listModels leaves out draft-only MTP repos', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: ['org/Qwen-27B-MTP-4bit', 'org/qwen_mtp', 'mtp-draft', 'org/Qwen-27B-4bit', 'org/smtp-model'].map((id) => ({ id })) }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const names = await providers.listModels(make({ url: `http://127.0.0.1:${server.address().port}/v1` }));
        assert.deepEqual(names, ['org/Qwen-27B-4bit', 'org/smtp-model']);
    } finally { server.close(); }
});

test('a stream that fails shows the server\'s reason, as a string or an object', async () => {
    const run = async (error) => {
        const server = http.createServer((req, res) => {
            req.resume();
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(`data: ${JSON.stringify({ error })}\n\n`);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            await providers.complete(make({ url: `http://127.0.0.1:${server.address().port}/v1`, label: 'MLX' }), { system: 's', messages: [{ role: 'user', content: 'hi' }] });
            return '';
        } catch (e) { return e.message; } finally { server.close(); }
    };
    assert.equal(await run("'Draft' object has no attribute 'language_model'"), "MLX: 'Draft' object has no attribute 'language_model'.");
    assert.equal(await run({ message: 'overloaded' }), 'MLX: overloaded.');
    assert.equal(await run({ code: 500 }), 'MLX: the stream failed.');
});

test('an HTTP error shows a reason sent as a plain string', async () => {
    const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no such model' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        await assert.rejects(providers.complete(make({ url: `http://127.0.0.1:${server.address().port}/v1`, label: 'MLX' }), { system: 's', messages: [{ role: 'user', content: 'hi' }] }), /MLX failed \(HTTP 500\): no such model/);
    } finally { server.close(); }
});

test('an empty answer says why', async () => {
    const run = async (events) => {
        const server = http.createServer((req, res) => {
            req.resume();
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
            res.end('data: [DONE]\n\n');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            await providers.complete(make({ url: `http://127.0.0.1:${server.address().port}/v1`, maxTokens: 50 }), { system: 's', messages: [{ role: 'user', content: 'hi' }] });
            return '';
        } catch (error) { return error.message; } finally { server.close(); }
    };
    assert.match(await run([{ choices: [{ delta: { reasoning: 'hmm' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }]), /all 50 tokens thinking/);
    assert.match(await run([{ choices: [{ delta: {}, finish_reason: 'length' }] }]), /50 token limit/);
    assert.match(await run([{ choices: [{ delta: { role: 'assistant' } }] }]), /closed the connection.*server's own log/);
});
