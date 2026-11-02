// Client for the Trifle bridge (../server/http.mjs in the trifle repository).
//
// The bridge speaks HTTP: GET /api/stream is an NDJSON stream of pi's records, POST /api/command writes one RPC command
// to pi, and every request carries the bridge's bearer token. To ask a question we open the stream, POST a `prompt`
// command, and read events until pi's `agent_end`; the assistant's reply is the text of its last message.
//
// The conversation lives in pi's session (the same one the Trifle web page shows), so only the new message is sent.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The contained setup (./run_contained.sh in trifle) serves the bridge on 8792, a plain run on 8787.
const DEFAULT_URLS = ['http://127.0.0.1:8792', 'http://127.0.0.1:8787'];

class TrifleError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.name = 'TrifleError';
        this.status = status;
    }
}

function defaultTokenFile(env) {
    return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'trifle', 'token');
}

// { url, token } from the environment: TRIFLE_URL, and TRIFLE_TOKEN or TRIFLE_TOKEN_FILE (default
// ~/.config/trifle/token, where the bridge keeps it). token is '' when there is none: the assistant then runs in demo mode.
function loadConfig(env = process.env) {
    let token = (env.TRIFLE_TOKEN || '').trim();
    if (!token) {
        const file = env.TRIFLE_TOKEN_FILE || defaultTokenFile(env);
        try {
            token = fs.readFileSync(file, 'utf8').trim();
        } catch { /* no token file: demo mode */ }
    }
    return { url: (env.TRIFLE_URL || '').replace(/\/+$/, ''), token };
}

async function* ndjson(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
                yield JSON.parse(line);
            } catch { /* not a protocol line */ }
        }
    }
}

function statusError(response, what) {
    if (response.status === 401) return new TrifleError('Trifle rejected the access token (TRIFLE_TOKEN).', 502);
    if (response.status === 403) {
        return new TrifleError('Trifle refused this request. If the editor runs in Docker, start Trifle\'s bridge with'
            + ' --allow-host host.docker.internal.', 502);
    }
    if (response.status === 503) return new TrifleError('Trifle\'s agent (pi) is not ready yet. Try again in a moment.', 503);
    return new TrifleError(`Trifle ${what} failed (HTTP ${response.status}).`);
}

class TrifleClient {
    constructor(config = loadConfig(), { timeoutMs = 300000 } = {}) {
        this.config = config;
        this.timeoutMs = timeoutMs;
        this.resolved = null; // the bridge URL that last answered
    }

    get enabled() {
        return Boolean(this.config.token);
    }

    get headers() {
        return { Authorization: `Bearer ${this.config.token}` };
    }

    // The bridge to talk to: TRIFLE_URL when set, otherwise the first default that answers its health check.
    async baseUrl() {
        const candidates = this.config.url ? [this.config.url] : DEFAULT_URLS;
        const ordered = this.resolved ? [this.resolved, ...candidates.filter((url) => url !== this.resolved)] : candidates;
        let refused = null;
        for (const url of ordered) {
            try {
                const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
                if (response.ok) return (this.resolved = url);
                // The bridge answered but will not talk to this address: not the same as being down.
                if (response.status === 403) refused = url;
            } catch { /* try the next one */ }
        }
        if (refused) {
            const host = new URL(refused).hostname;
            throw new TrifleError(`Trifle is running at ${refused} but refuses the name "${host}" (HTTP 403, Host header not allowed).`
                + ` Start its bridge with --allow-host ${host}.`, 503);
        }
        throw new TrifleError(`Trifle is not reachable at ${ordered.join(' or ')}. Start it (./run_contained.sh in the trifle`
            + ' folder), or set TRIFLE_URL.', 503);
    }

    // For the status line in the editor: never throws.
    async status() {
        if (!this.enabled) return { mode: 'demo', detail: 'No Trifle access token found (set TRIFLE_TOKEN).' };
        try {
            return { mode: 'trifle', reachable: true, url: await this.baseUrl() };
        } catch (error) {
            return { mode: 'trifle', reachable: false, detail: error.message };
        }
    }

    // Send `message` as a prompt and resolve { text, tools } when pi finishes. `tools` names the tools it used.
    async ask(message, { timeoutMs = this.timeoutMs } = {}) {
        if (!this.enabled) throw new TrifleError('Trifle is not configured.', 503);
        const base = await this.baseUrl();
        const clientId = `ed${crypto.randomBytes(6).toString('hex')}`; // the bridge wants [a-z0-9]{1,32}
        const commandId = `${clientId}-p1`;
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        try {
            const stream = await fetch(`${base}/api/stream?client=${clientId}`, { headers: this.headers, signal: controller.signal });
            if (!stream.ok) throw statusError(stream, 'stream');
            const lines = ndjson(stream.body);
            const hello = await lines.next();
            if (hello.done || hello.value.kind !== 'hello') throw new TrifleError('Trifle did not answer like a bridge.');

            const posted = await fetch(`${base}/api/command`, {
                method: 'POST',
                headers: { ...this.headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'prompt', id: commandId, message }),
                signal: controller.signal
            });
            if (!posted.ok) throw statusError(posted, 'request');

            let accepted = false;
            let reply = '';
            const tools = [];
            for await (const line of lines) {
                if (line.kind !== 'event' || !line.data) continue;
                const record = line.data;
                if (record.type === 'response' && record.id === commandId) {
                    if (!record.success) throw new TrifleError(record.error || 'Trifle did not accept the message.', 502);
                    accepted = true;
                } else if (!accepted) {
                    continue; // another client's traffic before our message was taken
                } else if (record.type === 'tool_execution_start') {
                    if (record.toolName && !tools.includes(record.toolName)) tools.push(record.toolName);
                } else if (record.type === 'message_end' && record.message?.role === 'assistant') {
                    if (record.message.stopReason === 'error' || record.message.stopReason === 'aborted') {
                        throw new TrifleError(record.message.errorMessage || `The model stopped (${record.message.stopReason}).`);
                    }
                    const text = (record.message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
                    if (text) reply = text; // the last assistant message with text is the answer
                } else if (record.type === 'agent_end') {
                    if (!reply) throw new TrifleError('Trifle finished without an answer.');
                    return { text: reply, tools };
                }
            }
            throw new TrifleError('The connection to Trifle closed before it finished.');
        } catch (error) {
            if (timedOut) {
                // Stop pi working on a question nobody is waiting for any more.
                fetch(`${base}/api/command`, {
                    method: 'POST',
                    headers: { ...this.headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'abort', id: `${clientId}-a1` }),
                    signal: AbortSignal.timeout(3000)
                }).catch(() => {});
                throw new TrifleError(`Trifle took longer than ${Math.round(timeoutMs / 1000)} s; I stopped it.`, 504);
            }
            throw error;
        } finally {
            clearTimeout(timer);
            controller.abort();
        }
    }
}

module.exports = { TrifleClient, TrifleError, loadConfig };
