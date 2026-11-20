// Model providers for the assistant. Two wire formats cover almost everything:
//   openai     /chat/completions (MLX, Ollama, llama.cpp, OpenAI, OpenRouter, ...)
//   anthropic  /v1/messages (Claude)
// plus `trifle`, which hands the prompt to Trifle's bridge (see trifle.js).
//
// Providers come from PROVIDERS_FILE, else the file setup.js saved, else providers.json, else the environment. An API key
// is never stored in a file: a provider names the environment variable that holds it (`keyEnv`). On a Mac the bridge also
// looks in the Keychain, for an item named `keychain`, or by default the same as keyEnv.
//
// In the container nothing here touches a key or a provider: with BRIDGE_URL set, requests go to the bridge on the machine
// that runs the container (bridge.js), which holds the provider list and the keys and uses this same file to do so.
const fs = require('fs');
const path = require('path');

class ProviderError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.name = 'ProviderError';
        this.status = status;
    }
}

const KINDS = new Set(['openai', 'anthropic', 'trifle']);
const DEFAULT_IDLE_MS = 120000; // longest silence from a model; a local one may be loading
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|host\.docker\.internal)$/i;
const CHAT_PATH = { openai: '/chat/completions', anthropic: '/v1/messages' };

function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
}

// Fields a provider's `extraBody` may not set, as Kaleidoscope sets them itself (maxTokens sets max_tokens).
const OWN_FIELDS = new Set(['model', 'messages', 'system', 'stream', 'max_tokens']);

// The provider's `extraBody`: fields added to each chat request as they are, such as sampling settings. {} if there are none.
function extraBody(raw, id, name = 'extraBody') {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`provider "${id}": ${name} must be an object of request fields`);
    const own = Object.keys(raw).filter((field) => OWN_FIELDS.has(field));
    if (own.length) throw new Error(`provider "${id}": ${name} cannot set ${own.join(', ')}, which Kaleidoscope sets itself`);
    return { ...raw };
}

// The provider's `thinking`: { on, off }, the request fields that turn the model's thinking on and off, such as
// { "enable_thinking": true } for a Qwen on an MLX server. With it, the chat offers a dial for how long the model may think.
// null if the provider has none.
function thinkingModes(raw, id) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw) || !raw.on) {
        throw new Error(`provider "${id}": thinking must be { "on": {...}, "off": {...} }, the request fields that turn thinking on and off`);
    }
    return { on: extraBody(raw.on, id, 'thinking.on'), off: extraBody(raw.off, id, 'thinking.off') };
}

function normalise(raw, index) {
    if (!raw || typeof raw !== 'object') throw new Error(`providers[${index}] is not an object`);
    const kind = raw.kind;
    if (!KINDS.has(kind)) throw new Error(`providers[${index}]: kind must be one of ${[...KINDS].join(', ')}`);
    const id = String(raw.id || '').trim();
    if (!/^[\w-]{1,40}$/.test(id)) throw new Error(`providers[${index}]: id must be 1-40 letters, digits, - or _`);
    if (kind !== 'trifle' && !raw.model) throw new Error(`provider "${id}": model is required`);
    const url = String(raw.url || (kind === 'anthropic' ? 'https://api.anthropic.com' : '')).replace(/\/+$/, '');
    if (kind === 'openai' && !url) throw new Error(`provider "${id}": url is required (e.g. http://127.0.0.1:8081/v1)`);
    const host = hostOf(url);
    return {
        id,
        kind,
        label: String(raw.label || id),
        url,
        model: raw.model ? String(raw.model) : '',
        keyEnv: raw.keyEnv ? String(raw.keyEnv) : '',
        keychain: raw.keyEnv ? String(raw.keychain || raw.keyEnv) : '',
        local: raw.local !== undefined ? Boolean(raw.local) : kind === 'trifle' || LOOPBACK.test(host),
        host,
        contextChars: Number(raw.contextChars) > 0 ? Number(raw.contextChars) : 32000,
        maxTokens: Number(raw.maxTokens) > 0 ? Number(raw.maxTokens) : 4096,
        temperature: raw.temperature === undefined ? undefined : Number(raw.temperature),
        extraBody: extraBody(raw.extraBody, id),
        thinking: kind === 'trifle' ? null : thinkingModes(raw.thinking, id),
        idleMs: (Number(raw.timeoutSeconds) > 0 ? Number(raw.timeoutSeconds) : DEFAULT_IDLE_MS / 1000) * 1000
    };
}

// What to offer when there is no providers.json: a local MLX server, plus whatever the environment has keys for.
function builtinProviders(env, { trifleEnabled = false } = {}) {
    const list = [{
        id: 'mlx',
        label: 'MLX (local)',
        kind: 'openai',
        url: env.MLX_URL || 'http://127.0.0.1:8081/v1',
        model: env.MLX_MODEL || 'default_model'
    }];
    if (env.ANTHROPIC_API_KEY) {
        list.push({ id: 'claude', label: 'Claude', kind: 'anthropic', model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', keyEnv: 'ANTHROPIC_API_KEY', contextChars: 400000 });
    }
    if (env.OPENAI_API_KEY && env.OPENAI_MODEL) {
        list.push({ id: 'openai', label: 'OpenAI', kind: 'openai', url: env.OPENAI_URL || 'https://api.openai.com/v1', model: env.OPENAI_MODEL, keyEnv: 'OPENAI_API_KEY', contextChars: 400000 });
    }
    if (trifleEnabled) list.push({ id: 'trifle', label: 'Trifle', kind: 'trifle' });
    return list;
}

// Where setup.js saves your providers: outside the repository, as they are yours. '' if there is no home folder to say.
function userProvidersFile(env = process.env) {
    const config = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, '.config') : '');
    return config ? path.join(config, 'kaleidoscope', 'providers.json') : '';
}

// { providers, default } from PROVIDERS_FILE, the file from setup.js or providers.json, falling back to the built-in list.
function loadProviders(env = process.env, { dir = __dirname, trifleEnabled = false } = {}) {
    const saved = userProvidersFile(env);
    const file = env.PROVIDERS_FILE || (saved && fs.existsSync(saved) ? saved : path.join(dir, 'providers.json'));
    let raw;
    let source;
    if (fs.existsSync(file)) {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            throw new Error(`${file} is not valid JSON: ${error.message}`);
        }
        raw = Array.isArray(parsed) ? parsed : parsed.providers;
        if (!Array.isArray(raw)) throw new Error(`${file}: expected a "providers" array`);
        source = { file, preferred: Array.isArray(parsed) ? '' : parsed.default };
    } else {
        raw = builtinProviders(env, { trifleEnabled });
        source = { file: null, preferred: '' };
    }
    const providers = raw.map(normalise);
    const ids = new Set();
    for (const provider of providers) {
        if (ids.has(provider.id)) throw new Error(`duplicate provider id "${provider.id}"`);
        ids.add(provider.id);
    }
    return { providers, preferred: source.preferred || '', file: source.file };
}

const apiKey = (provider, env = process.env) => (provider.keyEnv ? (env[provider.keyEnv] || '').trim() : '');

// Why there is no key. The bridge sets `missing` when it has looked further than the environment.
const missingKey = (provider) => provider.missing || `${provider.keyEnv} is not set on this machine.`;

// How a provider's own API is told the key.
function authHeaders(provider, key) {
    if (provider.kind === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    return key ? { Authorization: `Bearer ${key}` } : {};
}

// ---- The bridge, seen from the container ----
const bridgeUrl = (env) => (env.BRIDGE_URL || '').trim().replace(/\/+$/, '');
const bridgeHeaders = (env) => ({ Authorization: `Bearer ${(env.BRIDGE_TOKEN || '').trim()}` });
const bridgeDown = (url) => `Cannot reach the bridge at ${url}. ./run_contained.sh starts it; with Docker Compose, run node bridge.js on this machine.`;

// { providers, preferred, error } as the bridge has them. A provider comes with its `status`, except Trifle, which is not
// the bridge's to answer for. It has no keyEnv: the key is the bridge's concern, not the caller's.
async function fromBridge(env = process.env) {
    const url = bridgeUrl(env);
    const failed = (error) => ({ providers: [], preferred: '', error });
    try {
        const response = await fetch(`${url}/providers`, { headers: bridgeHeaders(env), signal: AbortSignal.timeout(8000) });
        const body = await response.json();
        return response.ok ? body : failed(body.bridge || `The bridge failed (HTTP ${response.status}).`);
    } catch {
        return failed(bridgeDown(url));
    }
}

// Is this provider usable right now? { ready, detail }. A local server is probed; a hosted one needs its key.
async function probe(provider, { env = process.env, trifle } = {}) {
    if (provider.kind === 'trifle') {
        const status = trifle ? await trifle.status() : { reachable: false, detail: 'Trifle is not configured.' };
        return { ready: Boolean(status.reachable), detail: status.reachable ? status.url : status.detail };
    }
    if (provider.keyEnv && !apiKey(provider, env)) {
        return { ready: false, detail: missingKey(provider) };
    }
    if (provider.kind === 'openai' && provider.local) {
        try {
            const response = await fetch(`${provider.url}/models`, { signal: AbortSignal.timeout(1500) });
            return { ready: response.ok || response.status === 401, detail: response.ok ? provider.url : `HTTP ${response.status} from ${provider.url}` };
        } catch {
            return { ready: false, detail: `Nothing answers at ${provider.url}. Start the model server.` };
        }
    }
    return { ready: true, detail: provider.url || '' };
}

// MTP repos hold only a draft head for speculative decoding (--draft-model). They are in the Hugging Face cache, so an MLX
// server lists them, but asked to answer on its own one replaces the real model and then fails.
const DRAFT_ONLY = /(^|[^a-z0-9])mtp([^a-z0-9]|$)/i;

// The model names a provider says it can serve, for the model picker: [] when it cannot say (or is not reachable). An
// MLX server lists the models in the local Hugging Face cache and loads whichever one a request names.
async function listModels(provider, { env = process.env } = {}) {
    if (provider.kind === 'trifle') return [];
    const key = apiKey(provider, env);
    if (provider.keyEnv && !key) return [];
    const url = provider.kind === 'anthropic' ? `${provider.url}/v1/models?limit=100` : `${provider.url}/models`;
    try {
        const response = await fetch(url, { headers: authHeaders(provider, key), signal: AbortSignal.timeout(3000) });
        if (!response.ok) return [];
        const body = await response.json();
        const names = (Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [])
            .map((entry) => (typeof entry === 'string' ? entry : entry && (entry.id || entry.name)))
            .filter((name) => typeof name === 'string' && name && !DRAFT_ONLY.test(name));
        return [...new Set(names)].sort((a, b) => a.localeCompare(b)).slice(0, 500);
    } catch {
        return [];
    }
}

// What the page shows of a provider: status(provider) resolves { ready, detail, models }. Probing a local model server on
// every page load is cheap, but not on every keystroke of a script, so answers are remembered briefly. A local server's models
// come and go as the user downloads them; a hosted one's list costs a network call, so it is kept longer.
function createStatus(options = {}) {
    const probes = new Map();
    const lists = new Map();
    async function remembered(cache, id, ms, read) {
        const cached = cache.get(id);
        if (cached && Date.now() - cached.at < ms) return cached.value;
        const value = await read();
        cache.set(id, { at: Date.now(), value });
        return value;
    }
    return async function status(provider) {
        const { ready, detail } = await remembered(probes, provider.id, 3000, () => probe(provider, options));
        const models = ready ? await remembered(lists, provider.id, provider.local ? 3000 : 60000, () => listModels(provider, options)) : [];
        return { ready, detail, models };
    };
}

// Server-sent events from a streaming response: yields the `data:` payload of each event.
async function* sseData(body, idle) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
        idle();
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
            const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (data) yield data;
        }
    }
}

// The error in a response: most APIs send { message }, mlx_vlm.server a plain string.
const errorText = (error) => (typeof error === 'string' ? error : error?.message) || '';

async function errorFrom(response, provider) {
    let detail = '';
    try {
        const body = await response.text();
        try {
            const json = JSON.parse(body);
            if (json.bridge) return new ProviderError(json.bridge, response.status); // from the bridge, not the provider
            detail = errorText(json.error) || json.message || json.detail || '';
        } catch { detail = body.slice(0, 300); }
    } catch { /* no body */ }
    if (response.status === 401 || response.status === 403) {
        return new ProviderError(`${provider.label} rejected the API key (HTTP ${response.status})${detail ? ': ' + detail : ''}.`);
    }
    if (response.status === 429) return new ProviderError(`${provider.label} is rate limiting requests (HTTP 429)${detail ? ': ' + detail : ''}.`, 429);
    return new ProviderError(`${provider.label} failed (HTTP ${response.status})${detail ? ': ' + detail : ''}.`);
}

function connectionError(error, provider) {
    const code = error?.cause?.code || error?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || error?.message === 'fetch failed') {
        return new ProviderError(`Cannot reach ${provider.label} at ${provider.url}${code ? ` (${code})` : ''}.`
            + (provider.local ? ' Is the model server running?' : ' Check the network.'), 503);
    }
    return error;
}

// Why a stream ended without an answer, as far as the stream says.
function emptyAnswer(provider, { thought, finish }) {
    if (thought && finish === 'length') {
        return `${provider.label} used all ${provider.maxTokens} tokens thinking and never wrote an answer. Raise maxTokens for this provider in providers.json, or choose a model that does not think.`;
    }
    if (thought) return `${provider.label} sent its reasoning but no answer (finish: ${finish || 'none'}).`;
    if (finish === 'length') return `${provider.label} reached the ${provider.maxTokens} token limit before writing an answer. Raise maxTokens for this provider in providers.json.`;
    if (!finish) {
        return `${provider.label} closed the connection without answering. Check the model server's own log: a model too big for memory, or one that failed to load, ends like this.`;
    }
    return `${provider.label} sent an empty answer (finish: ${finish}).`;
}

// Stream one completion. `system` is a string, `messages` is [{ role: 'user' | 'assistant', content }]. `onText(delta)`
// receives the text as it arrives, and `onThinking(delta)` the reasoning the model sends apart from it. `thinking` true or
// false sends the provider's fields that turn thinking on or off; left out, neither is sent. Resolves { text, truncated }
// (truncated: the model hit its output limit). `signal` aborts the request; silence for longer than provider.idleMs also
// aborts it.
async function complete(provider, { system, messages, signal, thinking, onText = () => {}, onThinking = () => {}, env = process.env, trifle }) {
    if (provider.kind === 'trifle') {
        if (!trifle || !trifle.enabled) throw new ProviderError('Trifle is not configured.', 503);
        const prompt = [system, ...messages.map((m) => (m.role === 'user' ? m.content : ''))].filter(Boolean).join('\n\n');
        const { text } = await trifle.ask(prompt);
        onText(text);
        return { text, truncated: false };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    let stalled = false;
    let timer;
    const idle = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { stalled = true; controller.abort(); }, provider.idleMs);
    };

    try {
        idle();
        const key = apiKey(provider, env);
        if (provider.keyEnv && !key) throw new ProviderError(missingKey(provider), 503);
        const bridge = bridgeUrl(env);
        const body = {
            model: provider.model, max_tokens: provider.maxTokens, stream: true,
            ...(provider.kind === 'anthropic' ? { system, messages } : { messages: [{ role: 'system', content: system }, ...messages] }),
            ...provider.extraBody,
            ...(provider.thinking && thinking !== undefined ? provider.thinking[thinking ? 'on' : 'off'] : {}),
            ...(provider.temperature === undefined ? {} : { temperature: provider.temperature })
        };

        let response;
        try {
            response = await fetch((bridge ? `${bridge}/p/${provider.id}` : provider.url) + CHAT_PATH[provider.kind], {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(bridge ? bridgeHeaders(env) : authHeaders(provider, key)) },
                body: JSON.stringify(body),
                signal: controller.signal
            });
        } catch (error) {
            if (stalled) throw new ProviderError(`${provider.label} did not answer within ${Math.round(provider.idleMs / 1000)} s.`, 504);
            if (bridge && !signal?.aborted) throw new ProviderError(bridgeDown(bridge), 503);
            throw connectionError(error, provider);
        }
        if (!response.ok) throw await errorFrom(response, provider);

        let text = '';
        let truncated = false;
        let thought = 0; // characters of reasoning sent apart from the answer
        let finish = '';
        try {
            for await (const data of sseData(response.body, idle)) {
                if (data === '[DONE]') break;
                let event;
                try { event = JSON.parse(data); } catch { continue; }
                if (provider.kind === 'anthropic') {
                    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                        text += event.delta.text;
                        onText(event.delta.text);
                    } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
                        thought += (event.delta.thinking || '').length;
                        onThinking(event.delta.thinking || '');
                    } else if (event.type === 'message_delta' && event.delta?.stop_reason === 'max_tokens') {
                        truncated = true;
                    } else if (event.type === 'error') {
                        throw new ProviderError(`${provider.label}: ${event.error?.message || 'the stream failed'}.`);
                    }
                } else {
                    if (event.error) throw new ProviderError(`${provider.label}: ${errorText(event.error) || 'the stream failed'}.`);
                    const choice = event.choices?.[0];
                    const delta = choice?.delta?.content;
                    if (delta) {
                        text += delta;
                        onText(delta);
                    }
                    // Reasoning models may send their thinking in a field of its own, which is not part of the answer.
                    const reasoning = choice?.delta?.reasoning || choice?.delta?.reasoning_content || '';
                    if (reasoning) {
                        thought += reasoning.length;
                        onThinking(reasoning);
                    }
                    if (choice?.finish_reason) finish = choice.finish_reason;
                    if (choice?.finish_reason === 'length') truncated = true;
                }
            }
        } catch (error) {
            if (stalled) throw new ProviderError(`${provider.label} stopped answering for ${Math.round(provider.idleMs / 1000)} s.`, 504);
            throw error;
        }
        if (!text.trim()) throw new ProviderError(emptyAnswer(provider, { thought, finish }));
        return { text, truncated };
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        controller.abort();
    }
}

module.exports = {
    ProviderError, CHAT_PATH, userProvidersFile, loadProviders, builtinProviders, normalise, probe, listModels, createStatus, complete, apiKey,
    authHeaders, connectionError, fromBridge, missingKey
};
