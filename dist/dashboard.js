import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadSession, sessionFiles } from './dashboard-data.js';
const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>Session observatory</title><link rel="stylesheet" href="/dashboard/assets/dashboard.css"></head><body><div id="root"></div><script type="module" src="/dashboard/assets/dashboard.js"></script></body></html>`;
export function registerDashboard(app, directory, pricing) {
    app.get('/dashboard', async (_, reply) => reply.type('text/html').send(html));
    app.get('/dashboard/assets/:file', async (request, reply) => {
        const file = request.params.file;
        if (!/^[\w.-]+\.(js|css|woff2?)$/.test(file))
            return reply.code(404).send({ error: 'Asset not found' });
        try {
            const path = fileURLToPath(new URL(`../dist/public/${file}`, import.meta.url));
            const content = await readFile(path);
            return reply.type(file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'font/woff2').send(content);
        }
        catch {
            return reply.code(404).send({ error: 'Asset not found. Run npm run build:ui.' });
        }
    });
    app.get('/dashboard/api/sessions', async (_, reply) => {
        reply.header('Cache-Control', 'no-store');
        await pricing.ready;
        const sessions = [];
        for (const filename of await sessionFiles(directory)) {
            const session = await loadSession(directory, filename, pricing.catalog);
            if (session)
                sessions.push({ filename, bytes: session.bytes, modified: session.modified, stats: session.stats, warnings: session.warnings,
                    preview: session.preview, observations: session.observations });
        }
        return { sessions };
    });
    app.get('/dashboard/api/session', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (typeof request.query.session !== 'string')
            return reply.code(400).send({ error: 'A session filename is required' });
        await pricing.ready;
        const session = await loadSession(directory, request.query.session, pricing.catalog);
        if (!session)
            return reply.code(404).send({ error: 'Session not found' });
        if (request.query.item !== undefined) {
            const item = session.items.find(item => String(item.id) === request.query.item);
            if (!item)
                return reply.code(404).send({ error: 'Observation not found' });
            return { input: item.input ?? null, metadata: item.metadata };
        }
        return { ...session, items: session.items.map(({ input, ...item }) => item) };
    });
}
