// Model providers for the assistant. Two wire formats cover almost everything:
//   openai     /chat/completions (MLX, Ollama, llama.cpp, OpenAI, OpenRouter, ...)
//   anthropic  /v1/messages (Claude)
// plus `trifle`, which hands the prompt to Trifle's bridge (see trifle.js).
//
// Providers come from providers.json (or PROVIDERS_FILE) when it exists, otherwise from the environment. An API key
// is never stored in the file: a provider names the environment variable that holds it (`keyEnv`), and the key stays
// on the server.
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

function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
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
        local: raw.local !== undefined ? Boolean(raw.local) : kind === 'trifle' || LOOPBACK.test(host),
        host,
        contextChars: Number(raw.contextChars) > 0 ? Number(raw.contextChars) : 32000,
        maxTokens: Number(raw.maxTokens) > 0 ? Number(raw.maxTokens) : 4096,
        temperature: raw.temperature === undefined ? undefined : Number(raw.temperature),
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
        list.push({ id: 'claude', label: 'Claude', kind: 'anthropic', model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', keyEnv: 'ANTHROPIC_API_KEY' });
    }
    if (env.OPENAI_API_KEY && env.OPENAI_MODEL) {
        list.push({ id: 'openai', label: 'OpenAI', kind: 'openai', url: env.OPENAI_URL || 'https://api.openai.com/v1', model: env.OPENAI_MODEL, keyEnv: 'OPENAI_API_KEY' });
    }
    if (trifleEnabled) list.push({ id: 'trifle', label: 'Trifle', kind: 'trifle' });
    return list;
}

// { providers, default } from providers.json / PROVIDERS_FILE, falling back to the built-in list.
function loadProviders(env = process.env, { dir = __dirname, trifleEnabled = false } = {}) {
    const file = env.PROVIDERS_FILE || path.join(dir, 'providers.json');
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
    // In a container, "localhost" is the container itself: LOOPBACK_HOST names the machine that runs it instead.
    const loopback = (env.LOOPBACK_HOST || '').trim();
    const reach = (item) => (loopback && item && typeof item.url === 'string'
        ? { ...item, url: item.url.replace(/^(https?:\/\/)(localhost|127\.\d+\.\d+\.\d+)(?=[:/]|$)/i, `$1${loopback}`) }
        : item);
    const providers = raw.map(reach).map(normalise);
    const ids = new Set();
    for (const provider of providers) {
        if (ids.has(provider.id)) throw new Error(`duplicate provider id "${provider.id}"`);
        ids.add(provider.id);
    }
    return { providers, preferred: source.preferred || '', file: source.file };
}

const apiKey = (provider, env = process.env) => (provider.keyEnv ? (env[provider.keyEnv] || '').trim() : '');

// Is this provider usable right now? { ready, detail }. A local server is probed; a hosted one needs its key.
async function probe(provider, { env = process.env, trifle } = {}) {
    if (provider.kind === 'trifle') {
        const status = trifle ? await trifle.status() : { reachable: false, detail: 'Trifle is not configured.' };
        return { ready: Boolean(status.reachable), detail: status.reachable ? status.url : status.detail };
    }
    if (provider.keyEnv && !apiKey(provider, env)) {
        return { ready: false, detail: `${provider.keyEnv} is not set on the editor's server.` };
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

// The model names a provider says it can serve, for the model picker: [] when it cannot say (or is not reachable). An
// MLX server lists the models in the local Hugging Face cache and loads whichever one a request names.
async function listModels(provider, { env = process.env } = {}) {
    if (provider.kind === 'trifle') return [];
    const key = apiKey(provider, env);
    if (provider.keyEnv && !key) return [];
    const request = provider.kind === 'anthropic'
        ? { url: `${provider.url}/v1/models?limit=100`, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }
        : { url: `${provider.url}/models`, headers: key ? { Authorization: `Bearer ${key}` } : {} };
    try {
        const response = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(3000) });
        if (!response.ok) return [];
        const body = await response.json();
        const names = (Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [])
            .map((entry) => (typeof entry === 'string' ? entry : entry && (entry.id || entry.name)))
            .filter((name) => typeof name === 'string' && name);
        return [...new Set(names)].sort((a, b) => a.localeCompare(b)).slice(0, 500);
    } catch {
        return [];
    }
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

async function errorFrom(response, provider) {
    let detail = '';
    try {
        const body = await response.text();
        try {
            const json = JSON.parse(body);
            detail = json.error?.message || json.message || json.detail || '';
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
// receives the text as it arrives. Resolves { text, truncated } (truncated: the model hit its output limit).
// `signal` aborts the request; silence for longer than provider.idleMs also aborts it.
async function complete(provider, { system, messages, signal, onText = () => {}, env = process.env, trifle }) {
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
        if (provider.keyEnv && !key) throw new ProviderError(`${provider.keyEnv} is not set on the editor's server.`, 503);
        const request = provider.kind === 'anthropic'
            ? {
                url: `${provider.url}/v1/messages`,
                headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                body: { model: provider.model, max_tokens: provider.maxTokens, stream: true, system, messages,
                    ...(provider.temperature === undefined ? {} : { temperature: provider.temperature }) }
            }
            : {
                url: `${provider.url}/chat/completions`,
                headers: key ? { Authorization: `Bearer ${key}` } : {},
                body: { model: provider.model, max_tokens: provider.maxTokens, stream: true,
                    messages: [{ role: 'system', content: system }, ...messages],
                    ...(provider.temperature === undefined ? {} : { temperature: provider.temperature }) }
            };

        let response;
        try {
            response = await fetch(request.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...request.headers },
                body: JSON.stringify(request.body),
                signal: controller.signal
            });
        } catch (error) {
            if (stalled) throw new ProviderError(`${provider.label} did not answer within ${Math.round(provider.idleMs / 1000)} s.`, 504);
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
                    } else if (event.type === 'message_delta' && event.delta?.stop_reason === 'max_tokens') {
                        truncated = true;
                    } else if (event.type === 'error') {
                        throw new ProviderError(`${provider.label}: ${event.error?.message || 'the stream failed'}.`);
                    }
                } else {
                    if (event.error) throw new ProviderError(`${provider.label}: ${event.error.message || 'the stream failed'}.`);
                    const choice = event.choices?.[0];
                    const delta = choice?.delta?.content;
                    if (delta) {
                        text += delta;
                        onText(delta);
                    }
                    // Reasoning models may send their thinking in a field of its own, which is not part of the answer.
                    thought += (choice?.delta?.reasoning || choice?.delta?.reasoning_content || '').length;
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

module.exports = { ProviderError, loadProviders, builtinProviders, normalise, probe, listModels, complete, apiKey };
