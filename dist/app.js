import Fastify from 'fastify';
import { appendFile, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { registerDashboard } from './dashboard.js';
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const jsonAttributes = new Set([
    'langfuse.observation.metadata',
    'langfuse.observation.input',
    'langfuse.observation.output',
    'langfuse.observation.usage_details',
    'langfuse.observation.cost_details',
]);
function traceObservations(body) {
    if (!isRecord(body) || !Array.isArray(body.resourceSpans))
        return [];
    const observations = [];
    for (const resourceSpan of body.resourceSpans) {
        if (!isRecord(resourceSpan) || !Array.isArray(resourceSpan.scopeSpans))
            continue;
        for (const scopeSpan of resourceSpan.scopeSpans) {
            if (!isRecord(scopeSpan) || !Array.isArray(scopeSpan.spans))
                continue;
            for (const span of scopeSpan.spans) {
                if (!isRecord(span) || !Array.isArray(span.attributes))
                    continue;
                const attributes = {};
                for (const attribute of span.attributes) {
                    if (!isRecord(attribute) || typeof attribute.key !== 'string' || !isRecord(attribute.value))
                        continue;
                    const value = attribute.value;
                    // OTLP values are tagged (stringValue, boolValue, intValue, etc.).
                    const type = Object.keys(value)[0];
                    if (type && Object.hasOwn(value, type)) {
                        let decoded = value[type];
                        if (type === 'stringValue' && typeof decoded === 'string' && jsonAttributes.has(attribute.key)) {
                            try {
                                decoded = JSON.parse(decoded);
                            }
                            catch {
                                // Keep the original string if the value is not valid JSON.
                            }
                        }
                        Object.defineProperty(attributes, attribute.key, {
                            value: decoded, enumerable: true, configurable: true, writable: true,
                        });
                    }
                }
                observations.push({ attributes, span });
            }
        }
    }
    // Some plugin spans omit session.id. Associate only adjacent known observations,
    // rather than assigning unrelated spans to the last seen session.
    for (let index = 0; index < observations.length; index++) {
        const observation = observations[index];
        const type = observation.attributes['langfuse.observation.type'];
        const ownId = observation.attributes['session.id'];
        if (typeof ownId === 'string')
            observation.sessionId = ownId;
        if (observation.sessionId || type !== 'event' && type !== 'agent' && type !== 'tool')
            continue;
        const neighbors = type === 'event' ? [observations[index + 1]]
            : type === 'agent' ? [observations[index - 1]]
                : [observations[index - 1], observations[index + 1]];
        for (const neighbor of neighbors) {
            const neighborType = neighbor?.attributes['langfuse.observation.type'];
            if (neighborType === 'generation' || neighborType === 'tool') {
                const id = neighbor.sessionId ?? neighbor.attributes['session.id'];
                if (typeof id === 'string') {
                    observation.sessionId = id;
                    break;
                }
            }
        }
    }
    return observations;
}
function timestamp(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}
const comparedAttributes = [
    'langfuse.observation.type',
    'langfuse.observation.model.name',
    'langfuse.plugin.version',
    'langfuse.observation.metadata.opencodeVersion',
    'langfuse.user.id',
    'langfuse.environment',
    'langfuse.internal.is_app_root',
];
const inputKey = 'langfuse.observation.input';
const metadataKey = 'langfuse.observation.metadata';
export function defaultDataDirectory(moduleUrl = import.meta.url, currentDirectory = process.cwd(), homeDirectory = homedir()) {
    // tsx runs the TypeScript source in development; tsc emits JavaScript for releases.
    return extname(fileURLToPath(moduleUrl)) === '.ts'
        ? join(currentDirectory, 'data')
        : join(homeDirectory, '.local', 'share', 'opencode-langfuse-observability-local', 'data');
}
// Only retain fields needed for comparing the next observation, not its message history.
function updateState(state, entry) {
    for (const key of comparedAttributes) {
        if (Object.hasOwn(entry, key))
            state[key] = entry[key];
    }
    const input = entry[inputKey];
    if (isRecord(input)) {
        const previous = isRecord(state[inputKey]) ? state[inputKey] : {};
        const next = { ...previous };
        for (const key of ['system', 'tools']) {
            if (Object.hasOwn(input, key))
                next[key] = input[key];
        }
        state[inputKey] = next;
    }
    const metadata = entry[metadataKey];
    if (isRecord(metadata)) {
        state[metadataKey] = { ...(isRecord(state[metadataKey]) ? state[metadataKey] : {}), ...metadata };
    }
    else if (Object.hasOwn(entry, metadataKey)) {
        state[metadataKey] = metadata;
    }
}
function changedFields(attributes, state) {
    const entry = {};
    for (const key of comparedAttributes) {
        if (Object.hasOwn(attributes, key) && !isDeepStrictEqual(attributes[key], state[key]))
            entry[key] = attributes[key];
    }
    const input = attributes[inputKey];
    if (isRecord(input)) {
        const previous = isRecord(state[inputKey]) ? state[inputKey] : {};
        const changed = {};
        for (const key of ['system', 'tools']) {
            if (Object.hasOwn(input, key) && !isDeepStrictEqual(input[key], previous[key]))
                changed[key] = input[key];
        }
        if (Object.hasOwn(input, 'messages'))
            changed.messages = input.messages;
        if (Object.keys(changed).length)
            entry[inputKey] = changed;
    }
    const metadata = attributes[metadataKey];
    if (isRecord(metadata)) {
        const previous = isRecord(state[metadataKey]) ? state[metadataKey] : {};
        const changed = {};
        for (const [key, value] of Object.entries(metadata)) {
            if (!isDeepStrictEqual(value, previous[key])) {
                Object.defineProperty(changed, key, { value, enumerable: true, configurable: true, writable: true });
            }
        }
        if (Object.keys(changed).length)
            entry[metadataKey] = changed;
    }
    else if (Object.hasOwn(attributes, metadataKey) && !isDeepStrictEqual(metadata, state[metadataKey])) {
        entry[metadataKey] = metadata;
    }
    // Usage and cost belong to this turn, even if their values match the last turn.
    for (const key of ['langfuse.observation.usage_details', 'langfuse.observation.cost_details', 'langfuse.observation.output']) {
        if (Object.hasOwn(attributes, key))
            entry[key] = attributes[key];
    }
    return entry;
}
export function createApp(writeLine = (line) => process.stdout.write(line), dataDirectory = defaultDataDirectory(), now = () => new Date(), retentionDays = 30) {
    const app = Fastify();
    const pending = new Map();
    const sessions = new Map();
    async function cleanOldSessions() {
        let files;
        try {
            files = await readdir(dataDirectory, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        for (const file of files) {
            const match = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-(ses_[A-Za-z0-9_-]+)\.jsonl$/.exec(file.name);
            if (!file.isFile() || !match || pending.has(match[1]))
                continue;
            const sessionId = match[1];
            // Reserve the session while checking and deleting, so an incoming append
            // cannot race with removal of its file.
            const task = (async () => {
                try {
                    const path = join(dataDirectory, file.name);
                    const stat = await lstat(path);
                    if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff)
                        return;
                    await unlink(path);
                    if (sessions.get(sessionId)?.filename === file.name)
                        sessions.delete(sessionId);
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
            })();
            pending.set(sessionId, task);
            try {
                await task;
            }
            finally {
                if (pending.get(sessionId) === task)
                    pending.delete(sessionId);
            }
        }
    }
    let cleanupTimer;
    app.addHook('onReady', async () => {
        await cleanOldSessions();
        cleanupTimer = setInterval(() => {
            void cleanOldSessions().catch(error => app.log.error(error, 'Session cleanup failed'));
        }, 24 * 60 * 60 * 1000);
        cleanupTimer.unref();
    });
    app.addHook('onClose', async () => { if (cleanupTimer)
        clearInterval(cleanupTimer); });
    function saveObservation(observation, observedAt) {
        const { attributes, span, sessionId } = observation;
        if (typeof sessionId !== 'string' || !/^ses_[A-Za-z0-9_-]+$/.test(sessionId))
            return Promise.resolve();
        const times = {};
        for (const key of ['startTimeUnixNano', 'endTimeUnixNano']) {
            if (typeof span[key] === 'string')
                times[key] = span[key];
        }
        const previous = pending.get(sessionId) ?? Promise.resolve();
        const task = previous.then(async () => {
            let session = sessions.get(sessionId);
            if (!session) {
                await mkdir(dataDirectory, { recursive: true });
                const files = await readdir(dataDirectory);
                const existing = files.find((name) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-ses_[A-Za-z0-9_-]+\.jsonl$/.test(name)
                    && name.endsWith(`-${sessionId}.jsonl`));
                if (!existing) {
                    const filename = `${timestamp(observedAt)}-${sessionId}.jsonl`;
                    await writeFile(join(dataDirectory, filename), `${JSON.stringify({ ...attributes, 'session.id': sessionId, ...times })}\n`, 'utf8');
                    const state = {};
                    if (attributes['langfuse.observation.type'] === 'generation')
                        updateState(state, attributes);
                    sessions.set(sessionId, { filename, state });
                    return;
                }
                const state = {};
                const content = await readFile(join(dataDirectory, existing), 'utf8');
                for (const line of content.split('\n')) {
                    if (line.trim()) {
                        const entry = JSON.parse(line);
                        if (entry['langfuse.observation.type'] === 'generation'
                            || !Object.hasOwn(entry, 'langfuse.observation.type'))
                            updateState(state, entry);
                    }
                }
                session = { filename: existing, state };
            }
            const isGeneration = attributes['langfuse.observation.type'] === 'generation';
            const entry = isGeneration ? changedFields(attributes, session.state) : { ...attributes };
            if (isGeneration)
                entry['langfuse.observation.type'] = 'generation';
            else
                entry['session.id'] = sessionId;
            Object.assign(entry, times);
            await appendFile(join(dataDirectory, session.filename), `${JSON.stringify(entry)}\n`, 'utf8');
            if (isGeneration)
                updateState(session.state, entry);
            sessions.set(sessionId, session);
        });
        pending.set(sessionId, task);
        void task.finally(() => {
            if (pending.get(sessionId) === task)
                pending.delete(sessionId);
        }).catch(() => { });
        return task;
    }
    // Capture the stream before Fastify tries to parse it based on Content-Type.
    app.addHook('onRequest', async (request, reply) => {
        const path = request.url.split('?', 1)[0];
        if ((request.method === 'GET' || request.method === 'HEAD')
            && (path === '/dashboard' || path.startsWith('/dashboard/')))
            return;
        const chunks = [];
        for await (const chunk of request.raw) {
            chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        if (request.method === 'POST' && path === '/api/public/otel/v1/traces') {
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                // An invalid body on the traces endpoint is an unknown format too.
                parsed = undefined;
            }
            if (parsed !== undefined) {
                for (const observation of traceObservations(parsed)) {
                    const type = observation.attributes['langfuse.observation.type'];
                    if (type !== 'event' && type !== 'generation' && type !== 'agent' && type !== 'tool') {
                        if (type !== undefined)
                            writeLine(`${JSON.stringify({ format: 'unknown_observation', span: observation.span })}\n`);
                        continue;
                    }
                    const observedAt = now();
                    await saveObservation(observation, observedAt);
                }
                reply.code(204).send();
                return;
            }
        }
        writeLine(`${JSON.stringify({
            format: 'unknown',
            method: request.method,
            path,
            body: text,
            bodyBase64: body.toString('base64'),
        }, null, 2)}\n`);
        reply.code(204).send();
    });
    registerDashboard(app, dataDirectory);
    app.all('/', async () => { });
    app.all('/*', async () => { });
    return app;
}
