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

        const inContainer = providers.loadProviders({ LOOPBACK_HOST: 'host.docker.internal', MLX_URL: 'http://127.0.0.1:8081/v1' }, { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'none-')) });
        assert.equal(inContainer.providers[0].url, 'http://host.docker.internal:8081/v1');
        assert.equal(inContainer.providers[0].local, true);

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
