const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createBridge, fromKeychain, withKeychain } = require('../bridge');
const providers = require('../providers');

const KEY = 'the-real-secret-key';
const TOKEN = 'bridge-token';

const listen = async (server) => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
};

// A provider's API: remembers what it was sent, and answers as `reply` says.
async function upstream(reply) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body });
            reply(req, res);
        });
    });
    return { url: await listen(server), seen, close: () => { server.closeAllConnections(); server.close(); } };
}

const openaiAnswer = (req, res) => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.end('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};

const claudeAnswer = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n');
};

// A bridge over `list` in providers.json. Returns the env the container would have, which holds no key.
async function bridge(list, env = { MY_KEY: KEY }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ default: list[0].id, providers: list }));
    const server = createBridge({ token: TOKEN, env, dir });
    const url = await listen(server);
    return {
        url,
        container: { BRIDGE_URL: url, BRIDGE_TOKEN: TOKEN },
        close: () => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true }); }
    };
}

const ask = (provider, container, extra = {}) => providers.complete(provider, { system: 's', messages: [{ role: 'user', content: 'q' }], env: container, ...extra });
const authorised = { Authorization: `Bearer ${TOKEN}` };

test('a chat goes out with the real key, and the bridge token stays behind', async () => {
    const api = await upstream(openaiAnswer);
    const b = await bridge([{ id: 'hosted', kind: 'openai', url: `${api.url}/v1`, model: 'm', keyEnv: 'MY_KEY', local: false }]);
    try {
        const { providers: list } = await providers.fromBridge(b.container);
        const pieces = [];
        const result = await ask(list[0], b.container, { onText: (text) => pieces.push(text) });
        assert.equal(result.text, 'Hello');
        assert.deepEqual(pieces, ['Hel', 'lo']);
        const chat = api.seen.find((request) => request.method === 'POST');
        assert.equal(chat.url, '/v1/chat/completions');
        assert.equal(chat.headers.authorization, `Bearer ${KEY}`);
        assert.ok(!JSON.stringify(api.seen).includes(TOKEN));
    } finally { b.close(); api.close(); }
});

test('Claude gets its key its own way, and the model picked in the editor', async () => {
    const api = await upstream(claudeAnswer);
    const b = await bridge([{ id: 'claude', kind: 'anthropic', url: api.url, model: 'm', keyEnv: 'MY_KEY' }]);
    try {
        const { providers: list } = await providers.fromBridge(b.container);
        const result = await ask({ ...list[0], model: 'picked' }, b.container);
        assert.equal(result.text, 'Hi');
        const chat = api.seen.find((request) => request.method === 'POST');
        assert.equal(chat.url, '/v1/messages');
        assert.equal(chat.headers['x-api-key'], KEY);
        assert.equal(JSON.parse(chat.body).model, 'picked');
    } finally { b.close(); api.close(); }
});

test('a local server needs no key, and answers through the bridge the same way', async () => {
    const api = await upstream(openaiAnswer);
    const b = await bridge([{ id: 'mlx', kind: 'openai', url: `${api.url}/v1`, model: 'm' }], {});
    try {
        const { providers: list } = await providers.fromBridge(b.container);
        assert.deepEqual(list[0].status, { ready: true, detail: `${api.url}/v1`, models: ['model-a'] });
        assert.equal((await ask(list[0], b.container)).text, 'Hello');
        assert.equal(api.seen.find((request) => request.method === 'POST').headers.authorization, undefined);
    } finally { b.close(); api.close(); }
});

test('the provider list gives the container no key, and keeps saying what is hosted', async () => {
    const api = await upstream(openaiAnswer);
    const b = await bridge([
        { id: 'mlx', kind: 'openai', url: 'http://127.0.0.1:1/v1', model: 'm' },
        { id: 'hosted', kind: 'openai', url: 'https://api.example.com/v1', model: 'm', keyEnv: 'MY_KEY' },
        { id: 'unset', kind: 'anthropic', model: 'm', keyEnv: 'NOT_SET' },
        { id: 'trifle', kind: 'trifle' }
    ]);
    try {
        const response = await fetch(`${b.url}/providers`, { headers: authorised });
        const text = await response.text();
        assert.ok(!text.includes(KEY));
        assert.ok(!text.includes('keyEnv'));
        assert.ok(!text.includes('keychain'));
        const { providers: list, preferred } = JSON.parse(text);
        assert.equal(preferred, 'mlx');
        const byId = Object.fromEntries(list.map((provider) => [provider.id, provider]));
        assert.equal(byId.mlx.local, true);
        assert.equal(byId.hosted.local, false);
        assert.equal(byId.hosted.host, 'api.example.com');
        assert.equal(byId.unset.status.ready, false);
        assert.match(byId.unset.status.detail, /NOT_SET is not set on this machine/);
        assert.equal(byId.trifle.status, undefined); // for the editor to answer
    } finally { b.close(); api.close(); }
});

test('nothing but /health works without the token', async () => {
    const b = await bridge([{ id: 'x', kind: 'openai', url: 'http://127.0.0.1:1/v1', model: 'm' }]);
    try {
        assert.equal((await fetch(`${b.url}/health`)).status, 200);
        for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: TOKEN }]) {
            assert.equal((await fetch(`${b.url}/providers`, { headers })).status, 403);
            assert.equal((await fetch(`${b.url}/p/x/chat/completions`, { method: 'POST', headers, body: '{}' })).status, 403);
        }
        const refused = await providers.fromBridge({ ...b.container, BRIDGE_TOKEN: 'wrong' });
        assert.deepEqual(refused.providers, []);
        assert.match(refused.error, /refused this editor's token/);
        await assert.rejects(ask({ id: 'x', kind: 'openai', label: 'X', idleMs: 1000 }, { ...b.container, BRIDGE_TOKEN: 'wrong' }), /refused this editor's token/);
    } finally { b.close(); }
});

test('only the chat call of a known provider is passed on', async () => {
    const api = await upstream(openaiAnswer);
    const b = await bridge([{ id: 'x', kind: 'openai', url: `${api.url}/v1`, model: 'm', keyEnv: 'MY_KEY' }, { id: 't', kind: 'trifle' }]);
    try {
        const post = (route) => fetch(b.url + route, { method: 'POST', headers: authorised, body: '{}' });
        for (const route of ['/p/x/models', '/p/x/v1/messages', '/p/x/files', '/p/nobody/chat/completions', '/p/t/chat/completions',
            '/p/x/chat/completions/more', '/p/x/%2e%2e/admin', '/p/x/../../admin', '/anything']) {
            assert.equal((await post(route)).status, 404, route);
        }
        assert.equal((await fetch(`${b.url}/p/x/chat/completions`, { headers: authorised })).status, 404);
        assert.deepEqual(api.seen.filter((request) => request.method === 'POST'), []);
    } finally { b.close(); api.close(); }
});

test('a key not set on this machine is said so, without calling the provider', async () => {
    const api = await upstream(openaiAnswer);
    const b = await bridge([{ id: 'x', kind: 'openai', url: `${api.url}/v1`, model: 'm', keyEnv: 'MY_KEY' }], {});
    try {
        const { providers: list } = await providers.fromBridge(b.container);
        await assert.rejects(ask(list[0], b.container), /MY_KEY is not set on this machine/);
        assert.equal(api.seen.length, 0);
    } finally { b.close(); api.close(); }
});

test('a provider\'s refusal comes back as its own', async () => {
    const api = await upstream((req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
    });
    const b = await bridge([{ id: 'x', label: 'Hosted', kind: 'openai', url: `${api.url}/v1`, model: 'm', keyEnv: 'MY_KEY' }]);
    try {
        const list = (await providers.fromBridge(b.container)).providers;
        await assert.rejects(ask(list[0], b.container), /Hosted rejected the API key \(HTTP 401\): bad key/);
    } finally { b.close(); api.close(); }
});

test('a model server that is not running is named as the cause', async () => {
    const b = await bridge([{ id: 'x', label: 'MLX', kind: 'openai', url: 'http://127.0.0.1:1/v1', model: 'm' }]);
    try {
        const list = (await providers.fromBridge(b.container)).providers;
        assert.equal(list[0].status.ready, false);
        await assert.rejects(ask(list[0], b.container), /Cannot reach MLX at http:\/\/127\.0\.0\.1:1\/v1.*Is the model server running/);
    } finally { b.close(); }
});

test('with no bridge running, the editor says so', async () => {
    const closed = http.createServer();
    const url = await listen(closed);
    await new Promise((resolve) => { closed.close(resolve); });
    const container = { BRIDGE_URL: url, BRIDGE_TOKEN: TOKEN };
    const answer = await providers.fromBridge(container);
    assert.deepEqual(answer.providers, []);
    assert.match(answer.error, /Cannot reach the bridge/);
    await assert.rejects(ask({ id: 'x', kind: 'openai', label: 'X', idleMs: 1000 }, container), /Cannot reach the bridge/);
});

test('Stop reaches the provider', async () => {
    let gone;
    const dropped = new Promise((resolve) => { gone = resolve; });
    const api = await upstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
        res.on('close', gone);
    });
    const b = await bridge([{ id: 'x', kind: 'openai', url: `${api.url}/v1`, model: 'm' }]);
    try {
        const { providers: list } = await providers.fromBridge(b.container);
        const controller = new AbortController();
        const answer = ask(list[0], b.container, { signal: controller.signal, onText: () => controller.abort() });
        await assert.rejects(answer);
        await dropped;
    } finally { b.close(); api.close(); }
});

test('a request too long for the bridge is refused', async () => {
    const api = await upstream(openaiAnswer);
    const b = await bridge([{ id: 'x', kind: 'openai', url: `${api.url}/v1`, model: 'm' }]);
    try {
        const response = await fetch(`${b.url}/p/x/chat/completions`, { method: 'POST', headers: authorised, body: 'x'.repeat(13 * 1024 * 1024) });
        assert.equal(response.status, 413);
        assert.equal(api.seen.length, 0);
    } finally { b.close(); api.close(); }
});

const make = (raw) => providers.normalise({ kind: 'anthropic', model: 'm', ...raw }, 0);

test('a key not in the environment comes from the Keychain, under keyEnv or its own name', async () => {
    const asked = [];
    const list = [make({ id: 'a', keyEnv: 'KEY_A' }), make({ id: 'b', keyEnv: 'KEY_B', keychain: 'my item' }), make({ id: 'c' })];
    const env = await withKeychain(list, { OTHER: 'kept' }, async (service) => { asked.push(service); return `key of ${service}`; });
    assert.deepEqual(asked, ['KEY_A', 'my item']);
    assert.equal(providers.apiKey(list[0], env), 'key of KEY_A');
    assert.equal(providers.apiKey(list[1], env), 'key of my item');
    assert.equal(env.OTHER, 'kept');
});

test('a key in the environment is used without asking the Keychain', async () => {
    const list = [make({ id: 'a', keyEnv: 'KEY_A' })];
    const env = await withKeychain(list, { KEY_A: 'from env' }, async () => assert.fail('asked the Keychain'));
    assert.equal(providers.apiKey(list[0], env), 'from env');
});

test('two providers sharing a key ask the Keychain once', async () => {
    let asked = 0;
    const list = [make({ id: 'a', keyEnv: 'K' }), make({ id: 'b', keyEnv: 'K' })];
    await withKeychain(list, {}, async () => { asked++; return 'key'; });
    assert.equal(asked, 1);
});

test('a key the Keychain does not give is explained, and the container is not told the item name in the list', async () => {
    const api = await upstream(openaiAnswer);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
    const config = { providers: [providers.normalise({ id: 'x', kind: 'openai', url: `${api.url}/v1`, model: 'm', keyEnv: 'K', keychain: 'my item' }, 0)], preferred: '' };
    const env = await withKeychain(config.providers, {}, async () => '');
    const server = createBridge({ token: TOKEN, env, dir, config });
    const url = await listen(server);
    const container = { BRIDGE_URL: url, BRIDGE_TOKEN: TOKEN };
    try {
        const { providers: list } = await providers.fromBridge(container);
        assert.equal(list[0].status.ready, false);
        assert.match(list[0].status.detail, /K is not set, and your Keychain gave no key for an item named "my item"/);
        assert.equal(list[0].missing, undefined);
        assert.equal(list[0].keychain, undefined);
        await assert.rejects(ask(list[0], container), /your Keychain gave no key/);
        assert.equal(api.seen.length, 0);
    } finally { server.closeAllConnections(); server.close(); api.close(); fs.rmSync(dir, { recursive: true }); }
});

// Stands in for /usr/bin/security: prints the arguments it was given as the "key".
function fakeSecurity(script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-'));
    const file = path.join(dir, 'security');
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
}

test('fromKeychain asks for the password of one generic item, and trims it', async () => {
    const security = fakeSecurity('echo "$1|$2|$3|$4"');
    assert.equal(await fromKeychain('a;rm-x', { security }), 'find-generic-password|-s|a;rm-x|-w');
});

test('fromKeychain logs what went wrong and never the output', async () => {
    const lines = [];
    const security = fakeSecurity('echo secret-value; exit 44');
    assert.equal(await fromKeychain('item', { security, log: (line) => lines.push(line) }), '');
    assert.deepEqual(lines, ['Keychain: no key from "item" (no such item)']);
});

test('the real security tool reports an item that is not there', { skip: process.platform !== 'darwin' }, async () => {
    const lines = [];
    assert.equal(await fromKeychain('kaleidoscope-test-no-such-item', { log: (line) => lines.push(line) }), '');
    assert.match(lines[0], /no such item/);
});

test('the bridge will not start without a token', () => {
    assert.throws(() => createBridge({ token: '' }), /BRIDGE_TOKEN/);
});

test('a Keychain item that is plainly not an API key is not used', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaleidoscope-keychain-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const security = path.join(dir, 'security');
    const logged = [];
    const read = (output) => {
        fs.writeFileSync(security, `#!/bin/sh\ncat <<'END'\n${output}\nEND\n`, { mode: 0o755 });
        return fromKeychain('item', { security, log: (line) => logged.push(line) });
    };
    assert.equal(await read('{"claudeAiOauth":{"accessToken":"secret"}}'), '');
    assert.equal(await read('two words'), '');
    assert.deepEqual(logged, Array(2).fill('Keychain: "item" does not hold an API key, so it was not used'));
    assert.equal(await read('sk-ant-api03-Abc_123-xyz'), 'sk-ant-api03-Abc_123-xyz');
});
