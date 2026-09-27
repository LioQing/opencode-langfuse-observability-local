import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createApp, defaultDataDirectory } from './app.js';

test('uses the working directory in development and the home data directory in built releases', () => {
  const currentDirectory = join(tmpdir(), 'project');
  const homeDirectory = join(tmpdir(), 'home');
  assert.equal(defaultDataDirectory(pathToFileURL(join(currentDirectory, 'src', 'app.ts')).href, currentDirectory, homeDirectory),
    join(currentDirectory, 'data'));
  assert.equal(defaultDataDirectory(pathToFileURL(join(currentDirectory, 'dist', 'app.js')).href, currentDirectory, homeDirectory),
    join(homeDirectory, '.local', 'share', 'opencode-langfuse-observability-local', 'data'));
});

test('saves generation observations and prints unknown observation types', async (t) => {
  const lines: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createApp((line) => lines.push(line), directory);
  t.after(() => app.close());

  const generation = {
    attributes: [
      { key: 'langfuse.observation.type', value: { stringValue: 'generation' } },
      { key: 'session.id', value: { stringValue: 'ses_123' } },
      { key: 'langfuse.internal.is_app_root', value: { boolValue: false } },
      { key: 'langfuse.observation.metadata', value: { stringValue: '{"agent":"build"}' } },
      { key: 'langfuse.observation.input', value: { stringValue: '{"prompt":"hello"}' } },
      { key: 'langfuse.observation.output', value: { stringValue: '[{"role":"assistant","content":"hi"}]' } },
      { key: 'langfuse.observation.usage_details', value: { stringValue: '{"input":13}' } },
      { key: 'langfuse.observation.cost_details', value: { stringValue: '{"total":0}' } },
    ],
  };
  const response = await app.inject({
    method: 'POST',
    url: '/api/public/otel/v1/traces?source=test',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    payload: JSON.stringify({ resourceSpans: [
      { scopeSpans: [{ spans: [
        { attributes: [{ key: 'langfuse.observation.type', value: { stringValue: 'span' } }] },
        generation,
      ] }] },
      { scopeSpans: [{ spans: [generation] }] },
    ] }),
  });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { format: 'unknown_observation', span: { attributes: [{ key: 'langfuse.observation.type', value: { stringValue: 'span' } }] } },
  ]);
  const [filename] = await readdir(directory);
  const entries = (await readFile(join(directory, filename), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    'langfuse.observation.type': 'generation',
    'session.id': 'ses_123',
    'langfuse.internal.is_app_root': false,
    'langfuse.observation.metadata': { agent: 'build' },
    'langfuse.observation.input': { prompt: 'hello' },
    'langfuse.observation.output': [{ role: 'assistant', content: 'hi' }],
    'langfuse.observation.usage_details': { input: 13 },
    'langfuse.observation.cost_details': { total: 0 },
  });
});

test('appends generations to per-session JSONL files using the original filename', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let date = new Date(2026, 8, 27, 14, 5, 9, 123);
  let app = createApp(() => {}, directory, () => date);
  t.after(async () => app.close());

  const send = (sessionId: string, output: string) => app.inject({
    method: 'POST',
    url: '/api/public/otel/v1/traces',
    payload: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: [
      { key: 'langfuse.observation.type', value: { stringValue: 'generation' } },
      { key: 'session.id', value: { stringValue: sessionId } },
      { key: 'langfuse.observation.output', value: { stringValue: JSON.stringify([{ role: 'assistant', content: output }]) } },
    ] }] }] }] }),
  });

  assert.equal((await send('ses_123', 'first')).statusCode, 204);
  const filename = '2026-09-27-14-05-09-ses_123.jsonl';
  assert.deepEqual(await readdir(directory), [filename]);
  assert.deepEqual(JSON.parse((await readFile(join(directory, filename), 'utf8')).trim()), {
    'langfuse.observation.type': 'generation',
    'session.id': 'ses_123',
    'langfuse.observation.output': [{ role: 'assistant', content: 'first' }],
  });

  await app.close();
  date = new Date(2026, 8, 28, 16, 10, 11, 456);
  app = createApp(() => {}, directory, () => date);
  assert.equal((await send('ses_123', 'updated')).statusCode, 204);
  assert.equal((await send('ses_456', 'other')).statusCode, 204);
  assert.deepEqual((await readdir(directory)).sort(), [filename, '2026-09-28-16-10-11-ses_456.jsonl'].sort());
  const lines = (await readFile(join(directory, filename), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines[1], {
    'langfuse.observation.type': 'generation',
    'langfuse.observation.output': [{ role: 'assistant', content: 'updated' }],
  });
});

test('stores event, generation and agent separately with their own nanosecond timestamps', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const start = new Date(2026, 8, 27, 14, 5, 9, 123);
  let seconds = 0;
  const app = createApp(() => {}, directory, () => new Date(start.getTime() + seconds++ * 1000));
  t.after(() => app.close());

  const generation = (output: string) => ({ attributes: [
    { key: 'langfuse.observation.type', value: { stringValue: 'generation' } },
    { key: 'session.id', value: { stringValue: 'ses_123' } },
    { key: 'langfuse.observation.output', value: { stringValue: JSON.stringify([{ content: output }]) } },
  ] });
  const observation = (type: string, startTimeUnixNano: string, endTimeUnixNano: string) => ({
    startTimeUnixNano, endTimeUnixNano,
    attributes: [{ key: 'langfuse.observation.type', value: { stringValue: type } }],
  });
  const timedGeneration = (output: string, startTimeUnixNano: string, endTimeUnixNano: string) => ({
    ...generation(output), startTimeUnixNano, endTimeUnixNano,
  });
  const response = await app.inject({
    method: 'POST', url: '/api/public/otel/v1/traces',
    payload: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [
       observation('event', '1790517909123456789', '1790517909123456790'),
       timedGeneration('one', '1790517909133456789', '1790517909203456789'),
       observation('agent', '1790517909113456789', '1790517909234567890'),
       observation('event', '1790517910123456789', '1790517910123456790'),
       timedGeneration('two', '1790517910133456789', '1790517910203456789'),
       observation('agent', '1790517910113456789', '1790517910234567890'),
    ] }] }] }),
  });

  assert.equal(response.statusCode, 204);
  const filename = '2026-09-27-14-05-09-ses_123.jsonl';
  assert.deepEqual(await readdir(directory), [filename]);
  const lines = (await readFile(join(directory, filename), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0]['session.id'], 'ses_123');
  assert.deepEqual(lines.map((line) => line['langfuse.observation.type']),
    ['event', 'generation', 'agent', 'event', 'generation', 'agent']);
  assert.deepEqual(lines.map((line) => [line.startTimeUnixNano, line.endTimeUnixNano]), [
    ['1790517909123456789', '1790517909123456790'],
    ['1790517909133456789', '1790517909203456789'],
    ['1790517909113456789', '1790517909234567890'],
    ['1790517910123456789', '1790517910123456790'],
    ['1790517910133456789', '1790517910203456789'],
    ['1790517910113456789', '1790517910234567890'],
  ]);
  assert.ok(lines.every((line) => !Object.hasOwn(line, 'timestamp')));
});

test('saves standalone event and agent observations with their own session IDs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logs: string[] = [];
  const app = createApp((line) => logs.push(line), directory);
  t.after(() => app.close());

  const spans = ['event', 'agent'].map((type, index) => ({
    startTimeUnixNano: `123456789000000000${index}`,
    endTimeUnixNano: `123456789000000000${index + 1}`,
    attributes: [
      { key: 'langfuse.observation.type', value: { stringValue: type } },
      { key: 'session.id', value: { stringValue: 'ses_standalone' } },
    ],
  }));
  assert.equal((await app.inject({ method: 'POST', url: '/api/public/otel/v1/traces',
    payload: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
  })).statusCode, 204);
  assert.deepEqual(logs, []);
  const [filename] = await readdir(directory);
  const entries = (await readFile(join(directory, filename), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => entry['langfuse.observation.type']), ['event', 'agent']);
  assert.deepEqual(entries.map((entry) => [entry.startTimeUnixNano, entry.endTimeUnixNano]),
    spans.map((span) => [span.startTimeUnixNano, span.endTimeUnixNano]));
});

test('writes all fields for event, agent and tool, without changing generation comparison state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let app = createApp(() => {}, directory);
  t.after(async () => app.close());

  const span = (type: string, model: string, input: number) => ({
    startTimeUnixNano: '1790517909123456789', endTimeUnixNano: '1790517909234567890',
    attributes: [
      { key: 'langfuse.observation.type', value: { stringValue: type } },
      { key: 'session.id', value: { stringValue: 'ses_123' } },
      { key: 'langfuse.observation.model.name', value: { stringValue: model } },
      { key: 'langfuse.observation.metadata', value: { stringValue: '{"agent":"build"}' } },
      { key: 'langfuse.observation.input', value: { stringValue: JSON.stringify({ system: ['same'], messages: [input] }) } },
      { key: 'langfuse.internal.is_app_root', value: { boolValue: false } },
    ],
  });
  const send = (spans: ReturnType<typeof span>[]) => app.inject({
    method: 'POST', url: '/api/public/otel/v1/traces',
    payload: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
  });
  assert.equal((await send([span('generation', 'model-a', 1), span('event', 'model-b', 2),
    span('tool', 'model-b', 3), span('agent', 'model-b', 4)])).statusCode, 204);
  await app.close();
  app = createApp(() => {}, directory);
  assert.equal((await send([span('generation', 'model-a', 5)])).statusCode, 204);

  const [filename] = await readdir(directory);
  const entries = (await readFile(join(directory, filename), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => entry['langfuse.observation.type']),
    ['generation', 'event', 'tool', 'agent', 'generation']);
  for (const [index, input] of [[1, 2], [2, 3], [3, 4]]) {
    assert.deepEqual(entries[index], {
      'langfuse.observation.type': ['event', 'tool', 'agent'][index - 1],
      'session.id': 'ses_123',
      'langfuse.observation.model.name': 'model-b',
      'langfuse.observation.metadata': { agent: 'build' },
      'langfuse.observation.input': { system: ['same'], messages: [input] },
      'langfuse.internal.is_app_root': false,
      startTimeUnixNano: '1790517909123456789', endTimeUnixNano: '1790517909234567890',
    });
  }
  assert.deepEqual(entries[4], {
    'langfuse.observation.type': 'generation',
    'langfuse.observation.input': { messages: [5] },
    startTimeUnixNano: '1790517909123456789', endTimeUnixNano: '1790517909234567890',
  });
});

test('associates an adjacent tool and agent without session IDs with the generation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createApp(() => {}, directory);
  t.after(() => app.close());
  const spans = ['generation', 'tool', 'agent'].map((type) => ({
    attributes: [
      { key: 'langfuse.observation.type', value: { stringValue: type } },
      ...(type === 'generation' ? [{ key: 'session.id', value: { stringValue: 'ses_123' } }] : []),
    ],
  }));
  assert.equal((await app.inject({ method: 'POST', url: '/api/public/otel/v1/traces',
    payload: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
  })).statusCode, 204);
  const [filename] = await readdir(directory);
  const entries = (await readFile(join(directory, filename), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => entry['langfuse.observation.type']), ['generation', 'tool', 'agent']);
  assert.ok(entries.every((entry) => entry['session.id'] === 'ses_123'));
});

test('appends only changed fields, but always includes messages, output, usage and cost', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let date = new Date(2026, 8, 27, 14, 5, 9, 123);
  let app = createApp(() => {}, directory, () => date);
  t.after(async () => app.close());

  const send = (values: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: '/api/public/otel/v1/traces',
    payload: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: Object.entries({
      'langfuse.observation.type': 'generation',
      'session.id': 'ses_123',
      ...values,
    }).map(([key, value]) => ({ key, value: typeof value === 'boolean'
      ? { boolValue: value }
      : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } })) }] }] }] }),
  });
  const first = {
    'langfuse.observation.model.name': 'model-a',
    'langfuse.observation.input': { system: [{ text: 'system-a' }], tools: [{ name: 'tool-a' }], messages: [{ id: 1 }] },
    'langfuse.observation.metadata': { agent: 'build', messageID: 'first', nested: { x: 1, y: 2 } },
    'langfuse.plugin.version': '0.5.1',
    'langfuse.observation.metadata.opencodeVersion': '2.0.16',
    'langfuse.user.id': 'user',
    'langfuse.environment': 'development',
    'langfuse.internal.is_app_root': false,
    'langfuse.observation.output': [{ content: 'one' }],
    'langfuse.observation.usage_details': { input: 10 },
    'langfuse.observation.cost_details': { total: 0 },
  };
  assert.equal((await send(first)).statusCode, 204);

  // Restart to verify the comparison state can be reconstructed from the file.
  await app.close();
  date = new Date(2026, 8, 28, 16, 10, 11, 456);
  app = createApp(() => {}, directory, () => date);
  assert.equal((await send({
    ...first,
    'langfuse.observation.input': { system: [{ text: 'system-a' }], tools: [{ name: 'tool-a' }], messages: [{ id: 1 }, { id: 2 }] },
    'langfuse.observation.metadata': { agent: 'build', messageID: 'second', nested: { y: 2, x: 1 } },
    'langfuse.observation.output': [{ content: 'two' }],
  })).statusCode, 204);
  await app.close();
  date = new Date(2026, 8, 29, 18, 20, 21, 789);
  app = createApp(() => {}, directory, () => date);
  assert.equal((await send({
    ...first,
    'langfuse.observation.model.name': 'model-b',
    'langfuse.observation.input': { system: [{ text: 'system-b' }], tools: [{ name: 'tool-b' }], messages: [{ id: 3 }] },
    'langfuse.observation.metadata': { agent: 'build', messageID: 'second', nested: { x: 2, y: 2 } },
    'langfuse.environment': 'staging',
    'langfuse.internal.is_app_root': true,
    'langfuse.observation.output': [{ content: 'three' }],
  })).statusCode, 204);
  // Revert to the initial values: comparison must use the latest effective state, not the first line.
  date = new Date(2026, 8, 30, 19, 30, 31, 321);
  assert.equal((await send({ ...first, 'langfuse.observation.input': { ...first['langfuse.observation.input'], messages: [{ id: 4 }] } })).statusCode, 204);

  const filename = '2026-09-27-14-05-09-ses_123.jsonl';
  assert.deepEqual(await readdir(directory), [filename]);
  const content = await readFile(join(directory, filename), 'utf8');
  assert.ok(content.endsWith('\n'));
  const lines = content.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], { 'langfuse.observation.type': 'generation', 'session.id': 'ses_123', ...first,
  });
  assert.deepEqual(lines[1], {
    'langfuse.observation.type': 'generation',
    'langfuse.observation.input': { messages: [{ id: 1 }, { id: 2 }] },
    'langfuse.observation.metadata': { messageID: 'second' },
    'langfuse.observation.output': [{ content: 'two' }],
    'langfuse.observation.usage_details': { input: 10 },
    'langfuse.observation.cost_details': { total: 0 },
  });
  assert.deepEqual(lines[2], {
    'langfuse.observation.type': 'generation',
    'langfuse.observation.model.name': 'model-b',
    'langfuse.observation.input': { system: [{ text: 'system-b' }], tools: [{ name: 'tool-b' }], messages: [{ id: 3 }] },
    'langfuse.observation.metadata': { nested: { x: 2, y: 2 } },
    'langfuse.environment': 'staging',
    'langfuse.internal.is_app_root': true,
    'langfuse.observation.output': [{ content: 'three' }],
    'langfuse.observation.usage_details': { input: 10 },
    'langfuse.observation.cost_details': { total: 0 },
  });
  assert.deepEqual(lines[3]['langfuse.observation.metadata'], { messageID: 'first', nested: { x: 1, y: 2 } });
  assert.equal(Object.hasOwn(lines[3], 'timestamp'), false);
  assert.deepEqual(lines[3]['langfuse.observation.input'], { system: [{ text: 'system-a' }], tools: [{ name: 'tool-a' }], messages: [{ id: 4 }] });
  assert.equal(lines[3]['langfuse.observation.model.name'], 'model-a');
});

test('leaves legacy JSON files untouched and starts a new JSONL history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldName = '2026-09-27-13-33-33-ses_123.json';
  await writeFile(join(directory, oldName), '{"session.id":"ses_123"}\n');
  const app = createApp(() => {}, directory, () => new Date(2026, 8, 28, 16, 10, 11));
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST', url: '/api/public/otel/v1/traces',
    payload: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: [
      { key: 'langfuse.observation.type', value: { stringValue: 'generation' } },
      { key: 'session.id', value: { stringValue: 'ses_123' } },
    ] }] }] }] }),
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual((await readdir(directory)).sort(), [oldName, '2026-09-28-16-10-11-ses_123.jsonl'].sort());
  assert.equal(await readFile(join(directory, oldName), 'utf8'), '{"session.id":"ses_123"}\n');
});

test('leaves second-based timestamps in existing JSONL history unchanged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = '2026-09-27-14-05-09-ses_123.jsonl';
  await writeFile(join(directory, filename), '{"session.id":"ses_123","timestamp":1790489109}\n');
  const app = createApp(() => {}, directory, () => new Date(2026, 8, 28, 16, 10, 11, 456));
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST', url: '/api/public/otel/v1/traces',
    payload: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: [
      { key: 'langfuse.observation.type', value: { stringValue: 'generation' } },
      { key: 'session.id', value: { stringValue: 'ses_123' } },
    ] }] }] }] }),
  });

  assert.equal(response.statusCode, 204);
  const lines = (await readFile(join(directory, filename), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].timestamp, 1790489109);
  assert.equal(Object.hasOwn(lines[1], 'timestamp'), false);
});

test('does not write files for missing or unsafe session IDs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createApp(() => {}, directory);
  t.after(() => app.close());
  for (const sessionId of [undefined, '../outside']) {
    const attributes = [{ key: 'langfuse.observation.type', value: { stringValue: 'generation' } }];
    if (sessionId) attributes.push({ key: 'session.id', value: { stringValue: sessionId } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/public/otel/v1/traces',
      payload: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ attributes }] }] }] }),
    });
    assert.equal(response.statusCode, 204);
  }
  assert.deepEqual(await readdir(directory), []);
});

test('keeps malformed JSON attribute strings unchanged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traces-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lines: string[] = [];
  const app = createApp((line) => lines.push(line), directory);
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/public/otel/v1/traces',
    payload: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: [
      { key: 'langfuse.observation.type', value: { stringValue: 'generation' } },
      { key: 'session.id', value: { stringValue: 'ses_123' } },
      { key: 'langfuse.observation.input', value: { stringValue: '{invalid' } },
    ] }] }] }] }),
  });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(lines, []);
  const [filename] = await readdir(directory);
  assert.equal(JSON.parse((await readFile(join(directory, filename), 'utf8')).trim())['langfuse.observation.input'], '{invalid');
});

test('does not log valid JSON without generation spans', async (t) => {
  const lines: string[] = [];
  const app = createApp((line) => lines.push(line));
  t.after(() => app.close());

  for (const payload of ['{"resourceSpans":[]}', 'null', '{"resourceSpans":[{"scopeSpans":[{"spans":[{"attributes":[]}]}]}]}']) {
    const response = await app.inject({ method: 'POST', url: '/api/public/otel/v1/traces', payload });
    assert.equal(response.statusCode, 204);
  }
  assert.deepEqual(lines, []);
});

test('labels a different path as unknown and includes method, path and body', async (t) => {
  const lines: string[] = [];
  const app = createApp((line) => lines.push(line));
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/public/other',
    headers: { 'content-type': 'application/json' },
    payload: '{"event":"hello"}',
  });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(JSON.parse(lines[0]), {
    format: 'unknown',
    method: 'POST',
    path: '/api/public/other',
    body: '{"event":"hello"}',
    bodyBase64: Buffer.from('{"event":"hello"}').toString('base64'),
  });
});

test('labels invalid JSON on the traces endpoint as unknown', async (t) => {
  const lines: string[] = [];
  const app = createApp((line) => lines.push(line));
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/public/otel/v1/traces',
    headers: { 'content-type': 'application/json' },
    payload: '{invalid',
  });

  assert.equal(response.statusCode, 204);
  assert.equal(JSON.parse(lines[0]).format, 'unknown');
  assert.equal(JSON.parse(lines[0]).body, '{invalid');
});

test('labels other methods on the traces endpoint as unknown', async (t) => {
  const lines: string[] = [];
  const app = createApp((line) => lines.push(line));
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/public/otel/v1/traces' });

  assert.equal(response.statusCode, 204);
  assert.equal(JSON.parse(lines[0]).method, 'GET');
  assert.equal(JSON.parse(lines[0]).format, 'unknown');
});

test('preserves binary data for unknown requests', async (t) => {
  const lines: string[] = [];
  const app = createApp((line) => lines.push(line));
  t.after(() => app.close());
  const payload = Buffer.from([0, 255, 10, 42]);

  const response = await app.inject({
    method: 'PATCH',
    url: '/upload',
    headers: { 'content-type': 'application/octet-stream' },
    payload,
  });

  assert.equal(response.statusCode, 204);
  assert.equal(JSON.parse(lines[0]).bodyBase64, payload.toString('base64'));
});
