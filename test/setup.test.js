const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { keychainNames, hasKeychainItem, findServers, serverUrl, interview, save } = require('../setup');
const { loadProviders, normalise, userProvidersFile } = require('../providers');

const NONE = ''; // pressing Enter

// Answers the questions in order, and fails if there are too few or too many.
function script(...answers) {
    const said = [];
    const asked = [];
    return {
        said,
        asked,
        say: (text = '') => said.push(text),
        async ask(question) {
            asked.push(question);
            assert.ok(answers.length, `no answer left for: ${question}`);
            return answers.shift();
        },
        done: () => assert.deepEqual(answers, [], 'answers left over')
    };
}

const mac = (overrides = {}) => ({
    platform: 'darwin',
    node: '22.0.0',
    servers: [],
    configured: [],
    keysSet: [],
    keychainNames: [],
    hasKeychainItem: async () => true,
    trifle: false,
    ...overrides
});
const linux = (overrides = {}) => mac({ platform: 'linux', hasKeychainItem: null, ...overrides });
const mlx = { id: 'mlx', label: 'MLX (local)', kind: 'openai', url: 'http://127.0.0.1:8081/v1', model: 'any', models: ['qwen', 'gemma'] };

const tempDir = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaleidoscope-setup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
};

// A stand-in for macOS's security tool: records its arguments, prints `output` and exits with `code`.
function fakeSecurity(dir, output, code = 0) {
    const file = path.join(dir, 'security');
    const log = path.join(dir, 'arguments');
    fs.writeFileSync(file, `#!/bin/sh\necho "$@" >> '${log}'\ncat <<'END'\n${output}\nEND\nexit ${code}\n`, { mode: 0o755 });
    return { security: file, seen: () => fs.readFileSync(log, 'utf8').trim() };
}

test('a key in a Keychain item of another name is found and named', async () => {
    const machine = mac({ keychainNames: ['iCloud', 'trifle-anthropic', 'trifle-serpa'] });
    const io = script(NONE, NONE, NONE, 'n'); // no other server, use Claude, the item offered, not OpenAI
    const config = await interview(io, machine);
    io.done();
    assert.deepEqual(config, {
        default: 'claude',
        providers: [{ id: 'claude', label: 'Claude', kind: 'anthropic', model: 'claude-sonnet-5-5', keyEnv: 'ANTHROPIC_API_KEY', contextChars: 400000, keychain: 'trifle-anthropic' }]
    });
    assert.equal(normalise(config.providers[0], 0).keychain, 'trifle-anthropic');
    assert.ok(io.said.includes('    1. trifle-anthropic'));
    assert.ok(!io.said.some((line) => line.includes('trifle-serpa')), 'only names that look right are offered');
});

test('an app\'s own login is never offered as a key', async () => {
    const logins = ['Claude Code-credentials', 'Claude Safe Storage', 'ChatGPT Safe Storage', 'anthropic-oauth'];
    const io = script(NONE, 'y', 'typed-name', NONE);
    const { providers } = await interview(io, mac({ keychainNames: logins }));
    io.done();
    assert.equal(providers[0].keychain, 'typed-name');
    assert.match(io.asked[1], /\(y\/N\)/, 'and a login is no reason to default to yes');
    assert.ok(!io.said.some((line) => /Claude Code|Safe Storage|oauth/.test(line)));

    const both = script(NONE, NONE, NONE, 'n');
    const chosen = await interview(both, mac({ keychainNames: [...logins, 'trifle-anthropic'] }));
    both.done();
    assert.equal(chosen.providers[0].keychain, 'trifle-anthropic');
});

test('a hosted provider is offered by default only when a key looks to be there', async () => {
    const io = script(NONE, NONE, NONE);
    const config = await interview(io, mac());
    io.done();
    assert.deepEqual(config, { default: '', providers: [] });
    assert.match(io.asked[1], /Use Claude\? It sends the open file to Anthropic\. \(y\/N\)/);
});

test('a Keychain item named after the key needs no keychain field', async () => {
    const io = script(NONE, 'y', NONE, NONE);
    const { providers } = await interview(io, mac());
    io.done();
    assert.equal(providers[0].keyEnv, 'ANTHROPIC_API_KEY');
    assert.equal('keychain' in providers[0], false);
});

test('a Keychain item that does not exist is explained, and can be retyped or kept', async () => {
    const machine = mac({ hasKeychainItem: async (name) => name === 'right' });
    const io = script(NONE, 'y', 'wrong', 'n', 'right', NONE);
    const { providers } = await interview(io, machine);
    io.done();
    assert.equal(providers[0].keychain, 'right');
    assert.ok(io.said.includes('      security add-generic-password -s wrong -a "$USER" -w'));

    const later = script(NONE, 'y', 'later', NONE, NONE);
    assert.equal((await interview(later, mac({ hasKeychainItem: async () => false }))).providers[0].keychain, 'later');
    later.done();
});

test('a key already set on the machine is used without asking where it is', async () => {
    const machine = mac({ keysSet: ['ANTHROPIC_API_KEY'], hasKeychainItem: async () => assert.fail('no need to look') });
    const io = script(NONE, NONE, NONE);
    const { providers } = await interview(io, machine);
    io.done();
    assert.equal(providers[0].id, 'claude');
    assert.equal('keychain' in providers[0], false);
});

test('on Linux there are no Keychain questions, and it says where a key goes', async () => {
    const io = script(NONE, 'y', 'y', NONE);
    const { providers } = await interview(io, linux());
    io.done();
    assert.deepEqual(providers.map((provider) => provider.keyEnv), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    assert.ok(providers.every((provider) => !('keychain' in provider)));
    assert.ok(!io.said.some((line) => /macOS/.test(line)));
    assert.ok(io.said.some((line) => line.includes('Set ANTHROPIC_API_KEY in the environment or in .env')));
});

test('a local server found is offered with its models, and the choice is saved with local limits', async () => {
    const io = script(NONE, '2', NONE, NONE, NONE);
    const config = await interview(io, mac({ servers: [mlx] }));
    io.done();
    assert.equal(config.default, 'mlx');
    assert.deepEqual(config.providers, [{
        id: 'mlx', label: 'MLX (local)', kind: 'openai', url: 'http://127.0.0.1:8081/v1', model: 'gemma', contextChars: 100000, maxTokens: 16384, timeoutSeconds: 300
    }]);
});

test('a model can be typed, a lone model is not asked about, and a server can be turned down', async () => {
    const typed = script(NONE, 'mlx-community/Other', NONE, NONE, NONE);
    assert.equal((await interview(typed, mac({ servers: [mlx] }))).providers[0].model, 'mlx-community/Other');
    typed.done();

    const lone = script(NONE, NONE, NONE, NONE);
    assert.equal((await interview(lone, mac({ servers: [{ ...mlx, models: ['only'] }] }))).providers[0].model, 'only');
    lone.done();

    const declined = script('n', NONE, NONE, NONE);
    assert.deepEqual((await interview(declined, mac({ servers: [mlx] }))).providers, []);
    declined.done();
});

test('Enter keeps the model already configured for that server, if it still has it', async () => {
    const keep = script(NONE, NONE, NONE, NONE, NONE);
    const machine = mac({ servers: [mlx], configured: [{ url: mlx.url, model: 'gemma' }, { url: 'http://elsewhere/v1', model: 'qwen' }] });
    assert.equal((await interview(keep, machine)).providers[0].model, 'gemma');
    keep.done();

    const gone = script(NONE, NONE, NONE, NONE, NONE);
    assert.equal((await interview(gone, mac({ servers: [mlx], configured: [{ url: mlx.url, model: 'deleted' }] }))).providers[0].model, 'qwen');
    gone.done();
});

test('setting up again keeps a server\'s temperature, extraBody and thinking', async () => {
    const io = script(NONE, NONE, NONE, NONE, NONE);
    const thinking = { on: { enable_thinking: true }, off: { enable_thinking: false } };
    const before = normalise({ id: 'mlx', kind: 'openai', url: mlx.url, model: 'gemma', temperature: 0.6, extraBody: { top_k: 20 }, thinking }, 0);
    const saved = (await interview(io, mac({ servers: [mlx], configured: [before] }))).providers[0];
    assert.deepEqual(saved.extraBody, { top_k: 20 });
    assert.deepEqual(saved.thinking, thinking);
    assert.equal(saved.temperature, 0.6);
    io.done();

    const plain = script(NONE, NONE, NONE, NONE, NONE);
    const fresh = (await interview(plain, mac({ servers: [mlx], configured: [normalise({ id: 'mlx', kind: 'openai', url: mlx.url, model: 'gemma' }, 0)] }))).providers[0];
    assert.ok(!('extraBody' in fresh) && !('temperature' in fresh) && !('thinking' in fresh));
    plain.done();
});

test('with several providers it asks which to start with', async () => {
    const machine = mac({ servers: [mlx], keysSet: ['ANTHROPIC_API_KEY'] });
    const io = script(NONE, NONE, NONE, NONE, NONE, '2');
    const config = await interview(io, machine);
    io.done();
    assert.deepEqual(config.providers.map((provider) => provider.id), ['mlx', 'claude']);
    assert.equal(config.default, 'claude');
});

test('another server is added by address, listing its models or naming one', async (t) => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'remote-model' }] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const address = `http://127.0.0.1:${server.address().port}`;

    const io = script('not an address', address, NONE, NONE);
    const { providers } = await interview(io, mac());
    io.done();
    assert.equal(providers[0].url, `${address}/v1`);
    assert.equal(providers[0].model, 'remote-model');
    assert.ok(io.said.some((line) => line.startsWith('  That is not an address.')));

    const down = 'http://127.0.0.1:9/v1'; // nothing listens on the discard port
    const named = script(down, 'my-model', NONE, NONE);
    assert.equal((await interview(named, mac())).providers[0].model, 'my-model');
    named.done();

    const dropped = script(down, NONE, NONE, NONE);
    assert.deepEqual((await interview(dropped, mac())).providers, []);
    dropped.done();
});

test('what it found is reported, and an old Node is called out', async () => {
    const io = script(NONE, NONE, NONE, NONE, NONE);
    await interview(io, mac({ node: '18.19.0', servers: [{ ...mlx, models: ['one'] }], trifle: true }));
    assert.ok(io.said.some((line) => line.includes('Node 18.19.0, which is too old')));
    assert.ok(io.said.includes('  MLX (local) at http://127.0.0.1:8081/v1'));
    assert.ok(io.said.some((line) => line.includes('Trifle will be offered')));

    const fine = script(NONE, NONE, NONE);
    await interview(fine, mac());
    assert.ok(!fine.said.some((line) => /Node \d/.test(line)));
    assert.ok(fine.said.includes('  No local model server is answering'));
});

test('an address gets /v1 unless it ends in a version', () => {
    assert.equal(serverUrl('http://10.0.0.5:8000'), 'http://10.0.0.5:8000/v1');
    assert.equal(serverUrl('http://10.0.0.5:8000/'), 'http://10.0.0.5:8000/v1');
    assert.equal(serverUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
    assert.equal(serverUrl('10.0.0.5:8000'), '');
    assert.equal(serverUrl('ftp://host'), '');
});

test('only names come out of the Keychain, and no password is asked for', async (t) => {
    const dir = tempDir(t);
    const dump = [
        'keychain: "/Users/me/Library/Keychains/login.keychain-db"',
        'class: "genp"',
        'attributes:',
        '    "acct"<blob>="me"',
        '    "svce"<blob>="trifle-anthropic"',
        '    "svce"<blob>="trifle-anthropic"',
        '    "svce"<blob>=0x00FF  "bytes"',
        '    "svce"<blob>=<NULL>',
        '    "srvr"<blob>="example.com"',
        '    "svce"<blob>="OPENAI_API_KEY"'
    ].join('\n');
    const fake = fakeSecurity(dir, dump);
    assert.deepEqual(await keychainNames(fake), ['trifle-anthropic', 'OPENAI_API_KEY']);
    assert.equal(fake.seen(), 'dump-keychain');
});

test('a Keychain that cannot be listed just means no names', async (t) => {
    const fake = fakeSecurity(tempDir(t), 'nope', 1);
    assert.deepEqual(await keychainNames(fake), []);
    assert.deepEqual(await keychainNames({ security: '/nonexistent/security' }), []);
});

test('checking for an item does not read its password', async (t) => {
    const dir = tempDir(t);
    const fake = fakeSecurity(dir, 'attributes');
    assert.equal(await hasKeychainItem('trifle-anthropic', fake), true);
    assert.equal(fake.seen(), 'find-generic-password -s trifle-anthropic');
    assert.equal(await hasKeychainItem('x', fakeSecurity(tempDir(t), '', 44)), false);
});

test('a server with models is found, and one that is not a model server is not', async (t) => {
    const start = async (reply) => {
        const server = http.createServer(reply);
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        t.after(() => server.close());
        return server.address().port;
    };
    const models = await start((req, res) => res.end(JSON.stringify({ data: [{ id: 'a' }] })));
    const empty = await start((req, res) => res.end(JSON.stringify({ data: [] })));
    const web = await start((req, res) => { res.writeHead(404); res.end('nope'); });
    const found = await findServers([
        { id: 'one', label: 'One', port: models },
        { id: 'two', label: 'Two', port: empty },
        { id: 'three', label: 'Three', port: web },
        { id: 'four', label: 'Four', port: 9 }
    ]);
    assert.deepEqual(found.map((server) => [server.id, server.models]), [['one', ['a']]]);
});

test('the saved file is private, holds no key, and keeps what it replaces', (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'kaleidoscope', 'providers.json');
    save(file, { default: 'a', providers: [] });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    save(file, { default: 'b', providers: [] });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).default, 'b');
    assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).default, 'a');
});

test('providers load from PROVIDERS_FILE, then the saved file, then the repository', (t) => {
    const dir = tempDir(t);
    const list = (id) => JSON.stringify({ providers: [{ id, kind: 'openai', url: 'http://127.0.0.1:1/v1', model: 'm' }] });
    const first = (env) => loadProviders(env, { dir }).providers[0].id;
    fs.writeFileSync(path.join(dir, 'providers.json'), list('repository'));
    const home = { HOME: path.join(dir, 'home') };
    assert.equal(first(home), 'repository');

    const saved = userProvidersFile(home);
    assert.equal(saved, path.join(dir, 'home', '.config', 'kaleidoscope', 'providers.json'));
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    fs.writeFileSync(saved, list('saved'));
    assert.equal(first(home), 'saved');

    const chosen = path.join(dir, 'chosen.json');
    fs.writeFileSync(chosen, list('chosen'));
    assert.equal(first({ ...home, PROVIDERS_FILE: chosen }), 'chosen');

    assert.equal(userProvidersFile({ HOME: '/h', XDG_CONFIG_HOME: '/x' }), '/x/kaleidoscope/providers.json');
    assert.equal(userProvidersFile({}), '');
});

test('an empty saved list loads, so the assistant can be left off', (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'providers.json');
    save(file, { default: '', providers: [] });
    assert.deepEqual(loadProviders({ PROVIDERS_FILE: file }, { dir }).providers, []);
});
