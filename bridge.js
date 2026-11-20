// The bridge: runs on your machine, outside the container, and is the only part of Kaleidoscope that holds API keys or talks
// to model providers when the editor is contained. The container asks it what providers there are and sends it chat requests;
// it adds the real key and passes them on, to a local model server or a hosted API alike, streaming the answer back.
//
// The container holds only a token for this bridge. It is good for nothing else, and the bridge will use it for nothing but
// the chat call of a provider in providers.json. Bodies are passed on and never logged, and no key ever goes back.
//
//   BRIDGE_TOKEN=... node bridge.js      ./run_contained.sh starts it for you, with a new token each run
//
// It needs only Node: no packages. Settings come from the environment or .env, as they do for the server. A key found in neither
// is looked for in the macOS Keychain when the bridge starts, and from then on kept only in this process's memory.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { once } = require('events');
const { CHAT_PATH, loadProviders, createStatus, apiKey, authHeaders, connectionError, missingKey } = require('./providers');

const MAX_BODY_BYTES = 12 * 1024 * 1024; // above the most the editor sends: a 2 MB file and a short history
const DEFAULT_PORT = 8793;
const KEYCHAIN_WAIT_MS = 60000; // macOS may ask you to allow this, so leave time to answer

const digest = (text) => crypto.createHash('sha256').update(text).digest();
const sameToken = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

// What the container may know of a provider: not its keyEnv, which would have it looking for a key of its own.
function shown({ keyEnv, keychain, missing, ...provider }) {
    return provider;
}

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

// The password of the Keychain item named `service`, or '' if there is none, access was refused, or it is plainly not an API key:
// an app's login is often JSON, and must not be sent to a provider as one. The value comes back over a pipe, so it is never in a
// command line, and only what went wrong is logged.
function fromKeychain(service, { security = '/usr/bin/security', log = () => {} } = {}) {
    return new Promise((resolve) => {
        execFile(security, ['find-generic-password', '-s', service, '-w'], { timeout: KEYCHAIN_WAIT_MS }, (error, stdout) => {
            if (error) log(`Keychain: no key from "${service}" (${error.code === 44 ? 'no such item' : error.killed ? 'no answer to the prompt' : `security exited with ${error.code}`})`);
            const value = error ? '' : stdout.trim();
            if (/[\s{}"]/.test(value)) {
                log(`Keychain: "${service}" does not hold an API key, so it was not used`);
                return resolve('');
            }
            resolve(value);
        });
    });
}

// `env` with the keys the environment lacks, as far as read(service) can find them. One at a time: each may bring up a prompt.
// A provider whose key is not found says where it was looked for.
async function withKeychain(providers, env, read) {
    const keys = { ...env };
    for (const provider of providers) {
        if (!provider.keyEnv || apiKey(provider, keys)) continue;
        keys[provider.keyEnv] = await read(provider.keychain);
        if (!keys[provider.keyEnv]) {
            provider.missing = `${provider.keyEnv} is not set, and your Keychain gave no key for an item named "${provider.keychain}". See the bridge's log.`;
        }
    }
    return keys;
}

// The request's body, or null when it is too long.
async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return null;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function readConfig(env, dir) {
    try {
        return loadProviders(env, { dir });
    } catch (error) {
        return { providers: [], preferred: '', error: error.message };
    }
}

// Returns an http.Server, not yet listening. `env` holds the keys; `dir` is where to look for providers.json.
function createBridge({ token, env = process.env, dir = __dirname, config = readConfig(env, dir), log = () => {} }) {
    if (!token) throw new Error('BRIDGE_TOKEN is not set');
    const status = createStatus({ env });

    async function list(res) {
        const providers = await Promise.all(config.providers.map(async (provider) => (
            provider.kind === 'trifle' ? shown(provider) : { ...shown(provider), status: await status(provider) }
        )));
        json(res, 200, { providers, preferred: config.preferred, error: config.error || '' });
    }

    async function forward(req, res, provider) {
        const key = apiKey(provider, env);
        if (provider.keyEnv && !key) return json(res, 503, { bridge: missingKey(provider) });
        const body = await readBody(req);
        if (!body) return json(res, 413, { bridge: 'That request is too long for the bridge.' });

        const controller = new AbortController();
        res.on('close', () => controller.abort()); // Stop, or a model given up on, reaches the provider
        try {
            const upstream = await fetch(provider.url + CHAT_PATH[provider.kind], {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders(provider, key) },
                body,
                signal: controller.signal
            });
            log(`${provider.id}: HTTP ${upstream.status}`);
            res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
            for await (const chunk of upstream.body) {
                if (!res.write(chunk)) await once(res, 'drain');
            }
            res.end();
        } catch (error) {
            if (controller.signal.aborted) return;
            log(`${provider.id}: ${error.cause?.code || error.message}`);
            if (res.headersSent) return res.destroy();
            json(res, 503, { bridge: connectionError(error, provider).message });
        }
    }

    return http.createServer((req, res) => {
        const url = new URL(req.url, 'http://bridge');
        if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

        const given = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        if (!given || !sameToken(given[1], token)) {
            return json(res, 403, { bridge: 'The bridge refused this editor\'s token. Start the editor and the bridge together with ./run_contained.sh.' });
        }

        const route = /^\/p\/([\w-]+)(\/.*)$/.exec(url.pathname);
        const provider = route && config.providers.find((candidate) => candidate.id === route[1]);
        let answer;
        if (req.method === 'GET' && url.pathname === '/providers') answer = list(res);
        else if (req.method === 'POST' && provider && route[2] === CHAT_PATH[provider.kind]) answer = forward(req, res, provider);
        else return json(res, 404, { bridge: 'The bridge does not pass that on.' });
        answer.catch((error) => {
            log(`failed: ${error.message}`);
            if (res.headersSent) res.destroy();
            else json(res, 500, { bridge: 'The bridge failed. See its log.' });
        });
    });
}

if (require.main === module) {
    // A detached editor outlives its terminal, so the bridge must too. Node undoes nohup as it starts, so it has to be said here.
    process.on('SIGHUP', () => {});
    const envFile = path.join(__dirname, '.env');
    try {
        if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
    } catch (error) {
        console.warn('Could not load .env:', error.message);
    }
    const token = (process.env.BRIDGE_TOKEN || '').trim();
    if (!token) {
        console.error('BRIDGE_TOKEN is not set: the bridge will not run without one.');
        process.exit(1);
    }
    const host = process.env.BRIDGE_HOST || '127.0.0.1';
    const port = Number(process.env.BRIDGE_PORT) || DEFAULT_PORT;
    const config = readConfig(process.env, __dirname);
    const read = (service) => fromKeychain(service, { log: console.log });
    const keys = process.platform === 'darwin' ? withKeychain(config.providers, process.env, read) : Promise.resolve(process.env);
    keys.then((env) => {
        createBridge({ token, env, config, log: console.log }).listen(port, host, () => console.log(`Bridge listening on ${host}:${port}`));
    });
}

module.exports = { createBridge, fromKeychain, withKeychain };
