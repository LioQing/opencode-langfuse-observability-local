import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { createApp, defaultDataDirectory } from './app.js';
import { loadConfig } from './config.js';

test('loads configurable host, port and storage', () => {
  assert.deepEqual(loadConfig({}), {
    host: '127.0.0.1', port: 45873, dataDirectory: defaultDataDirectory(), retentionDays: 30,
  });
  assert.deepEqual(loadConfig({ HOST: 'localhost', PORT: '3443', DATA_DIR: 'storage', RETENTION_DAYS: '7' }), {
    host: 'localhost', port: 3443, dataDirectory: 'storage', retentionDays: 7,
  });
  for (const port of ['0', '-1', '65536', '3.5', 'abc', '']) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT/);
  }
  assert.throws(() => loadConfig({ HOST: '' }), /HOST/);
  assert.throws(() => loadConfig({ DATA_DIR: '' }), /DATA_DIR/);
  for (const days of ['0', '-1', '3.5', 'abc', '', '9007199254740992']) {
    assert.throws(() => loadConfig({ RETENTION_DAYS: days }), /RETENTION_DAYS/);
  }
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
