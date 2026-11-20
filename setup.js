// First-run setup for the assistant: finds out what this machine has, asks a few questions and writes the provider list to
// ~/.config/kaleidoscope/providers.json, which is yours and outside the repository. ./run_contained.sh runs it the first time,
// or when given --setup, and it can be run on its own with `node setup.js`.
//
// It never asks for a key, only where you keep one, so the file it writes holds no secret. In the Keychain it looks at item
// names only: neither call to `security` below touches a password, so neither brings up a prompt.
//
// It needs only Node: no packages. It runs on this machine and is not part of the container's image.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { loadProviders, normalise, probe, listModels, userProvidersFile } = require('./providers');

const SECURITY = '/usr/bin/security';
const MODELS_SHOWN = 15;
const NAMES_SHOWN = 9;
const LOCAL_LIMITS = { contextChars: 100000, maxTokens: 16384, timeoutSeconds: 300 }; // a local model may think at length, or still be loading
const HOSTED_CONTEXT = 400000; // characters of the document; beyond this it is cut down, as a whole file costs more on every question

// Where a local model server listens unless told otherwise. 8081 is this project's default for MLX; 8080 is the default of both
// mlx_lm.server and llama.cpp, which cannot be told apart from outside.
const LOCAL_SERVERS = [
    { id: 'mlx', label: 'MLX (local)', port: 8081 },
    { id: 'local', label: 'Local model server', port: 8080 },
    { id: 'lmstudio', label: 'LM Studio', port: 1234 },
    { id: 'ollama', label: 'Ollama', port: 11434 }
];

const HOSTED = [
    { id: 'claude', label: 'Claude', company: 'Anthropic', kind: 'anthropic', model: 'claude-sonnet-5-5', keyEnv: 'ANTHROPIC_API_KEY', contextChars: HOSTED_CONTEXT, looksLike: /anthropic|claude.*(api|key)/i },
    { id: 'openai', label: 'OpenAI', company: 'OpenAI', kind: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-5', keyEnv: 'OPENAI_API_KEY', contextChars: HOSTED_CONTEXT, looksLike: /openai|chatgpt.*(api|key)/i }
];

// Apps keep their own logins in the Keychain under names much like an API key's ("Claude Code-credentials", "Claude Safe Storage").
// Those are not keys, and must never be offered as one.
const NOT_A_KEY = /credential|safe storage|oauth|session|login|token/i;
const likelyItems = (names, provider) => names.filter((name) => provider.looksLike.test(name) && !NOT_A_KEY.test(name)).sort();

// The name of every password item in the Keychain, or [] if it cannot say. Without -d the dump leaves out passwords.
function keychainNames({ security = SECURITY } = {}) {
    return new Promise((resolve) => {
        execFile(security, ['dump-keychain'], { timeout: 10000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
            resolve(error ? [] : [...new Set([...stdout.matchAll(/"svce"<blob>="([^"\n]*)"/g)].map((match) => match[1]))]);
        });
    });
}

// Is there a password item with this name? This is the bridge's lookup without the -w that would read the password.
function hasKeychainItem(name, { security = SECURITY } = {}) {
    return new Promise((resolve) => {
        execFile(security, ['find-generic-password', '-s', name], { timeout: 5000 }, (error) => resolve(!error));
    });
}

// The local servers that answer and have a model to offer.
async function findServers(servers = LOCAL_SERVERS) {
    const found = await Promise.all(servers.map(async ({ id, label, port }) => {
        const entry = { id, label, kind: 'openai', url: `http://127.0.0.1:${port}/v1`, model: 'any' };
        const provider = normalise(entry, 0);
        const { ready } = await probe(provider, { env: {} });
        return ready ? { ...entry, models: await listModels(provider, { env: {} }) } : null;
    }));
    return found.filter((server) => server && server.models.length);
}

// What setup does not ask about but must not lose from a server's earlier entry: its temperature, extra request fields and
// thinking fields.
function kept(before) {
    if (!before) return {};
    return {
        ...(before.temperature === undefined ? {} : { temperature: before.temperature }),
        ...(Object.keys(before.extraBody || {}).length ? { extraBody: before.extraBody } : {}),
        ...(before.thinking ? { thinking: before.thinking } : {})
    };
}

// The providers as they stand, from an earlier setup or providers.json.
function configured(env) {
    try {
        return loadProviders(env, { dir: __dirname }).providers;
    } catch {
        return [];
    }
}

// What this machine has, for interview(). `env` already includes .env.
async function survey(env, { platform = process.platform } = {}) {
    const onMac = platform === 'darwin';
    const tokenFile = env.TRIFLE_TOKEN_FILE || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'trifle', 'token');
    return {
        platform,
        node: process.versions.node,
        servers: await findServers(),
        configured: configured(env),
        keysSet: HOSTED.map((provider) => provider.keyEnv).filter((name) => (env[name] || '').trim()),
        keychainNames: onMac ? await keychainNames() : [],
        hasKeychainItem: onMac ? hasKeychainItem : null,
        trifle: Boolean((env.TRIFLE_TOKEN || '').trim()) || fs.existsSync(tokenFile)
    };
}

// A question with numbered answers. Enter takes the first; anything else that is not a number comes back as typed.
async function choose(io, question, options) {
    options.forEach((option, index) => io.say(`    ${index + 1}. ${option}`));
    const answer = await io.ask(`  ${question} [1]: `);
    const number = Number(answer);
    if (!answer) return options[0];
    return Number.isInteger(number) && number >= 1 && number <= options.length ? options[number - 1] : answer;
}

async function yes(io, question, byDefault) {
    for (;;) {
        const answer = (await io.ask(`  ${question} (${byDefault ? 'Y/n' : 'y/N'}) `)).toLowerCase();
        if (!answer) return byDefault;
        if (['y', 'yes'].includes(answer)) return true;
        if (['n', 'no'].includes(answer)) return false;
    }
}

// `current` is the model already configured for this server: Enter keeps it. An MLX server loads whatever it is asked for, so the
// first name in its list could mean a long wait for a model nobody meant to use.
async function chooseModel(io, models, current) {
    if (models.length === 1) return models[0];
    const ordered = models.includes(current) ? [current, ...models.filter((model) => model !== current)] : models;
    io.say('  Models it offers:');
    return choose(io, 'Which one? You can also type a name, and change it later in the editor', ordered.slice(0, MODELS_SHOWN));
}

// The Keychain item for a provider's key. Returns the name, whether or not the item exists yet.
async function chooseKeychainItem(io, machine, provider) {
    const likely = likelyItems(machine.keychainNames, provider).slice(0, NAMES_SHOWN);
    for (;;) {
        let name;
        if (likely.length) {
            io.say('  Keychain items that look right:');
            name = await choose(io, 'Which holds the key? You can also type a name', likely);
        } else {
            name = await io.ask(`  What is the Keychain item called? [${provider.keyEnv}]: `) || provider.keyEnv;
        }
        if (await machine.hasKeychainItem(name)) return name;
        io.say(`  There is no Keychain item called "${name}". To add one, run this in another terminal; it asks for the key:`);
        io.say(`      security add-generic-password -s ${name} -a "$USER" -w`);
        if (await yes(io, 'Keep this name and add the key later?', true)) return name;
    }
}

// A hosted provider's entry, or null if it is not wanted. Without a key found, the answer defaults to no.
async function askHosted(io, machine, { company, looksLike, ...provider }) {
    const hasKey = machine.keysSet.includes(provider.keyEnv);
    const canAsk = Boolean(machine.hasKeychainItem);
    const likely = canAsk && likelyItems(machine.keychainNames, { looksLike }).length > 0;
    if (!await yes(io, `Use ${provider.label}? It sends the open file to ${company}.`, hasKey || likely)) return null;
    if (hasKey) {
        io.say(`  ${provider.keyEnv} is set on this machine, so that key will be used.`);
        return provider;
    }
    if (!canAsk) {
        io.say(`  Set ${provider.keyEnv} in the environment or in .env beside run_contained.sh (git ignores that file).`);
        io.say(`  Until then ${provider.label} shows as not ready.`);
        return provider;
    }
    const item = await chooseKeychainItem(io, machine, { ...provider, looksLike });
    return item === provider.keyEnv ? provider : { ...provider, keychain: item };
}

// An address as typed, ready to use, or '' if it is not one.
function serverUrl(text) {
    try {
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol)) return '';
        const address = url.href.replace(/\/+$/, '');
        return /\/v\d+$/.test(address) ? address : `${address}/v1`;
    } catch {
        return '';
    }
}

// Any server the search could not find: one not running yet, on another port, or on another machine.
async function askOtherServer(io) {
    for (;;) {
        const answer = await io.ask('  Any other OpenAI-compatible model server? Its address, or Enter for none: ');
        if (!answer) return null;
        const url = serverUrl(answer);
        if (!url) {
            io.say('  That is not an address. It looks like http://127.0.0.1:8081/v1');
            continue;
        }
        const entry = { id: 'other', label: 'Model server', kind: 'openai', url, ...LOCAL_LIMITS };
        const offered = await listModels(normalise({ ...entry, model: 'any' }, 0), { env: {} });
        if (offered.length) return { ...entry, model: await chooseModel(io, offered) };
        const model = await io.ask('  It did not list any models. Which model should it use? (Enter to leave this server out): ');
        return model ? { ...entry, model } : null;
    }
}

// Asks the questions and returns the config to save: { default, providers }.
async function interview(io, machine) {
    const onMac = machine.platform === 'darwin';
    io.say();
    io.say('Setting up the assistant. It asks where your keys are kept, never for a key.');
    io.say();
    io.say('On this machine:');
    io.say(onMac ? '  macOS, so API keys can stay in the Keychain' : '  API keys come from the environment or .env, as there is no Keychain here');
    if (Number(machine.node.split('.')[0]) < 20) io.say(`  Node ${machine.node}, which is too old for the bridge: it needs Node 20 or later`);
    for (const server of machine.servers) io.say(`  ${server.label} at ${server.url}`);
    if (!machine.servers.length) io.say('  No local model server is answering');
    if (machine.trifle) io.say('  A token for Trifle, so Trifle will be offered too');
    io.say();

    const providers = [];
    for (const { models, ...server } of machine.servers) {
        if (!await yes(io, `Use ${server.label}? Your text stays on this machine.`, true)) continue;
        const before = machine.configured.find((provider) => provider.url === server.url);
        providers.push({ ...server, model: await chooseModel(io, models, before?.model), ...LOCAL_LIMITS, ...kept(before) });
    }
    const other = await askOtherServer(io);
    if (other) providers.push(other);
    for (const provider of HOSTED) {
        const chosen = await askHosted(io, machine, provider);
        if (chosen) providers.push(chosen);
    }

    let preferred = providers[0]?.id || '';
    if (providers.length > 1) {
        io.say('  Your providers:');
        const label = await choose(io, 'Which should the editor start with?', providers.map((provider) => provider.label));
        preferred = (providers.find((provider) => provider.label === label) || providers[0]).id;
    }
    return { default: preferred, providers };
}

// Writes the config. A file being replaced is kept beside it, in case it was edited by hand.
function save(file, config) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function report(io, file, { default: preferred, providers }) {
    io.say();
    if (!providers.length) io.say('No providers chosen, so the assistant is off. The editor works without it.');
    for (const provider of providers) {
        const where = provider.keyEnv ? `key from ${provider.keychain ? `Keychain item "${provider.keychain}"` : provider.keyEnv}` : provider.url;
        io.say(`  ${provider.label}: ${provider.model}, ${where}${provider.id === preferred ? ' (selected at the start)' : ''}`);
    }
    io.say(`Saved in ${file}. No key is stored there. To change it, edit that file or run ./run_contained.sh --setup`);
    io.say();
}

function terminal() {
    const lines = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answers = lines[Symbol.asyncIterator]();
    const cancel = () => {
        console.log('\nSetup cancelled. Nothing was saved.');
        process.exit(130);
    };
    lines.on('SIGINT', cancel);
    return {
        say: (text = '') => console.log(text),
        async ask(question) {
            lines.setPrompt(question);
            lines.prompt();
            const { value, done } = await answers.next();
            if (done) cancel();
            return value.trim();
        },
        close: () => lines.close()
    };
}

async function main() {
    const envFile = path.join(__dirname, '.env');
    try {
        if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
    } catch (error) {
        console.warn('Could not load .env:', error.message);
    }
    const file = userProvidersFile(process.env);
    if (!file) throw new Error('Neither HOME nor XDG_CONFIG_HOME is set, so there is nowhere to save the setup.');
    const io = terminal();
    const config = await interview(io, await survey(process.env));
    save(file, config);
    report(io, file, config);
    io.close();
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Setup failed: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { HOSTED, keychainNames, hasKeychainItem, findServers, survey, serverUrl, interview, save };
