import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { createApp, defaultDataDirectory } from './app.js';
import { loadConfig } from './config.js';

test('loads configurable host, port and storage', () => {
  assert.deepEqual(loadConfig({}), {
    host: '127.0.0.1', port: 3000, dataDirectory: defaultDataDirectory(),
  });
  assert.deepEqual(loadConfig({ HOST: 'localhost', PORT: '3443', DATA_DIR: 'storage' }), {
    host: 'localhost', port: 3443, dataDirectory: 'storage',
  });
  for (const port of ['0', '-1', '65536', '3.5', 'abc', '']) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT/);
  }
  assert.throws(() => loadConfig({ HOST: '' }), /HOST/);
  assert.throws(() => loadConfig({ DATA_DIR: '' }), /DATA_DIR/);
});

test('accepts trace requests over plain HTTP', async (t) => {
  const app = createApp(() => {});
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: address.port, method: 'POST',
      path: '/api/public/otel/v1/traces',
      headers: { 'content-type': 'application/json' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('{"resourceSpans":[]}');
  });
  assert.equal(status, 204);
});
