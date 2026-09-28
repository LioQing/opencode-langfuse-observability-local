import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from './app.js';
import { parseSession } from './dashboard-data.js';
import type { PricingStore } from './model-pricing.js';

const p = 'langfuse.observation.';
const lines = (...entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

test('reconstructs generation deltas in file order before newest-first nanosecond sorting and links early tool results', () => {
  const session = parseSession(lines(
    { [p + 'type']: 'event', [p + 'input']: [{ role: 'user', content: [{ type: 'text', text: 'Find something' }] }], startTimeUnixNano: '1790494890000000000' },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'call_1', tool: 'websearch', providerID: 'wrong' }, [p + 'output']: { output: 'Found it' }, startTimeUnixNano: '1790494892000000000' },
    { [p + 'type']: 'generation', [p + 'model.name']: 'test-model', [p + 'metadata']: { providerID: 'openai', variant: 'medium', mode: 'build' },
      [p + 'input']: { system: ['system'], tools: [{ name: 'websearch' }], messages: [{ role: 'user' }] },
      [p + 'output']: [{ role: 'assistant', tool_calls: [{ id: 'call_1', name: 'websearch' }] }],
      [p + 'usage_details']: { input: 100, output: 20, cache_read: 900, cache_write: 0, reasoning: 5, total: 125 }, [p + 'cost_details']: { total: 0 }, startTimeUnixNano: '1790494891000000001' },
    { [p + 'type']: 'agent', [p + 'metadata']: { variant: 'wrong' }, startTimeUnixNano: '1790494890000000000' },
    { [p + 'type']: 'generation', [p + 'metadata']: { variant: 'high' }, [p + 'input']: { messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }] }, startTimeUnixNano: '1790494891000000000' },
  ), 'test.jsonl');
  assert.deepEqual(session.items.map(item => item.id), [3, 5, 1]);
  const inherited = session.items[1];
  assert.equal(inherited.provider, 'openai');
  assert.equal(inherited.model, 'test-model');
  assert.equal(inherited.variant, 'high');
  assert.equal(inherited.mode, 'build');
  assert.deepEqual(inherited.input.system, ['system']);
  assert.deepEqual(inherited.input.tools, [{ name: 'websearch' }]);
  assert.deepEqual(inherited.counts, { total: 3, user: 1, assistant: 1, tool: 1, toolCalls: 0 });
  assert.deepEqual(inherited.outputCounts, { responses: null, reasoning: null });
  assert.equal(inherited.output, null);
  assert.equal(inherited.usage.input, null);
  assert.equal(inherited.cost, null);
  const generation = session.items[0];
  assert.equal(generation.tools[0].results[0].output.output, 'Found it');
  assert.deepEqual(generation.outputCounts, { responses: 0, reasoning: 0 });
  assert.equal(generation.tools[0].inferred, false);
  assert.equal(generation.uncached, 100);
  assert.equal(generation.reportedTotal, 125);
  assert.equal(generation.usage.total, 1025);
  assert.equal(generation.cacheHit, 0.9);
  assert.equal(generation.cost, 0);
  assert.equal(session.stats.usage.total, 1025);
  assert.equal(session.stats.toolCalls, 1);
  assert.equal(session.stats.missingUsage, 1);
});

test('counts tool result messages in input history independently of output tool calls', () => {
  const session = parseSession(lines(
    { [p + 'type']: 'generation', [p + 'input']: { messages: [{ role: 'user' }] }, [p + 'output']: [{ tool_calls: [{ id: 'one', name: 'read' }] }] },
    { [p + 'type']: 'generation', [p + 'input']: { messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'tool' }] } },
  ), 'roles.jsonl');
  assert.deepEqual(session.items[0].counts, { total: 1, user: 1, assistant: 0, tool: 0, toolCalls: 1 });
  assert.deepEqual(session.items[1].counts, { total: 4, user: 1, assistant: 1, tool: 2, toolCalls: 0 });
  assert.equal(session.stats.toolCalls, 1);
});

test('counts output responses and reasoning per message, separate from calls and token usage', () => {
  const session = parseSession(lines(
    { [p + 'type']: 'generation', [p + 'output']: [
      { role: 'assistant', thinking: 'Plan', content: [{ type: 'reasoning', text: 'Thought' }, { type: 'text', text: 'Answer' }], tool_calls: [{ id: 'one', name: 'read' }, { id: 'two', name: 'grep' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'More thought' }] },
      { role: 'assistant', content: 'Final answer' },
    ] },
    { [p + 'type']: 'generation', [p + 'output']: [], [p + 'usage_details']: { reasoning: 42 } },
  ), 'output-counts.jsonl');
  assert.deepEqual(session.items[0].outputCounts, { responses: 2, reasoning: 2 });
  assert.equal(session.items[0].counts.toolCalls, 2);
  assert.deepEqual(session.items[1].outputCounts, { responses: 0, reasoning: 0 });
});

test('calculates session duration from earliest to latest observation, not summed generation time', () => {
  const session = parseSession(lines(
    { [p + 'type']: 'generation', startTimeUnixNano: '5000000000', endTimeUnixNano: '6000000000' },
    { [p + 'type']: 'event', [p + 'input']: 'First request', startTimeUnixNano: '1000000000' },
    { [p + 'type']: 'tool', startTimeUnixNano: '12500000000' },
    { [p + 'type']: 'agent' },
  ), 'duration.jsonl');
  assert.equal(session.stats.durationMs, 11500);
  assert.equal(session.stats.durationPartial, true);
  assert.equal(session.stats.generationDurationMs, 1000);
  assert.equal(session.stats.generationDurationPartial, false);
  assert.equal(parseSession(lines({ [p + 'type']: 'event', startTimeUnixNano: '100' }), 'one.jsonl').stats.durationMs, null);
  assert.equal(parseSession(lines({ [p + 'type']: 'event', startTimeUnixNano: '100' }, { [p + 'type']: 'event', startTimeUnixNano: '100' }), 'same.jsonl').stats.durationMs, 0);
});

test('sums only recorded generation durations and keeps missing durations distinct from zero', () => {
  const session = parseSession(lines(
    { [p + 'type']: 'event', startTimeUnixNano: '1000000000' },
    { [p + 'type']: 'generation', startTimeUnixNano: '2000000000', endTimeUnixNano: '4000000000' },
    { [p + 'type']: 'generation', startTimeUnixNano: '5000000000' },
    { [p + 'type']: 'generation', startTimeUnixNano: '6000000000', endTimeUnixNano: '6000000000' },
    { [p + 'type']: 'tool', startTimeUnixNano: '7000000000', endTimeUnixNano: '10000000000' },
  ), 'generation-duration.jsonl');
  assert.equal(session.stats.durationMs, 6000);
  assert.equal(session.stats.generationDurationMs, 2000);
  assert.equal(session.stats.generationDurationPartial, true);
  const missing = parseSession(lines({ [p + 'type']: 'generation', startTimeUnixNano: '100' }), 'missing.jsonl');
  assert.equal(missing.stats.generationDurationMs, null);
  assert.equal(missing.stats.generationDurationPartial, true);
  const empty = parseSession('', 'empty.jsonl');
  assert.equal(empty.stats.generationDurationMs, null);
  assert.equal(empty.stats.generationDurationPartial, false);
});

test('infers orphan tool results only inside one complete generation interval and counts observed calls', () => {
  const session = parseSession(lines(
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'orphan', tool: 'grep' }, [p + 'input']: { pattern: 'test' }, [p + 'output']: { output: 'match' }, startTimeUnixNano: '120', endTimeUnixNano: '140' },
    { [p + 'type']: 'generation', [p + 'output']: [{ role: 'assistant', thinking: 'searching' }], startTimeUnixNano: '100', endTimeUnixNano: '150' },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'later', tool: 'read' }, startTimeUnixNano: '220', endTimeUnixNano: '240' },
    { [p + 'type']: 'generation', startTimeUnixNano: '200', endTimeUnixNano: '250' },
  ), 'inferred.jsonl');
  assert.deepEqual(session.items.map(item => item.id), [4, 2]);
  assert.equal(session.items[1].summary, 'Reasoning + tool(grep)');
  assert.equal(session.items[1].reasoning, true);
  assert.equal(session.items[1].response, false);
  assert.deepEqual(session.items[1].tools[0].results.map(result => result.id), [1]);
  assert.equal(session.items[1].tools[0].inferred, true);
  assert.deepEqual(session.items[1].tools[0].results[0].input, { pattern: 'test' });
  assert.equal(session.items[0].summary, 'tool(read)');
  assert.equal(session.stats.toolCalls, 2);
  assert.equal(session.items[1].counts.toolCalls, 0);
});

test('leaves ambiguous, incomplete and out-of-interval tools standalone; exact call IDs still win', () => {
  const session = parseSession(lines(
    { [p + 'type']: 'generation', [p + 'output']: [{ tool_calls: [{ id: 'exact', name: 'read' }] }], startTimeUnixNano: '100', endTimeUnixNano: '300' },
    { [p + 'type']: 'generation', startTimeUnixNano: '150', endTimeUnixNano: '250' },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'exact', tool: 'read' }, startTimeUnixNano: '175', endTimeUnixNano: '180' },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'ambiguous', tool: 'grep' }, startTimeUnixNano: '180', endTimeUnixNano: '190' },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'overrun', tool: 'shell' }, startTimeUnixNano: '290', endTimeUnixNano: '310' },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'no-end', tool: 'glob' }, startTimeUnixNano: '120' },
    { [p + 'type']: 'generation', startTimeUnixNano: '400' },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'unfinished', tool: 'patch' }, startTimeUnixNano: '410', endTimeUnixNano: '420' },
  ), 'uncertain.jsonl');
  assert.deepEqual(session.items.filter(item => item.type === 'tool').map(item => item.id).sort(), [4, 5, 6, 8]);
  assert.equal(session.items.find(item => item.id === 1)!.tools[0].inferred, false);
  assert.equal(session.items.find(item => item.id === 1)!.tools[0].results[0].id, 3);
  assert.equal(session.stats.toolCalls, 5);
});

test('counts tool observations without generation output, without double-counting linked output calls', () => {
  const session = parseSession(lines(
    { [p + 'type']: 'generation', [p + 'output']: [{ tool_calls: [{ id: 'linked', name: 'read' }, { id: 'pending', name: 'grep' }] }], startTimeUnixNano: '100', endTimeUnixNano: '200' },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'linked', tool: 'read' }, startTimeUnixNano: '110', endTimeUnixNano: '120' },
    { [p + 'type']: 'generation', [p + 'output']: [{ role: 'assistant', content: 'Done' }], startTimeUnixNano: '300', endTimeUnixNano: '400' },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'outputless', tool: 'shell' }, startTimeUnixNano: '310', endTimeUnixNano: '320' },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'standalone', tool: 'patch' } },
  ), 'observed-tools.jsonl');
  assert.equal(session.stats.toolCalls, 4);
  assert.equal(session.items.find(item => item.id === 1)!.counts.toolCalls, 2);
  assert.equal(session.items.find(item => item.id === 3)!.counts.toolCalls, 0);
  assert.equal(session.items.find(item => item.id === 3)!.tools[0].inferred, true);
});

test('handles legacy deltas, orphan tools, missing results, malformed lines and unknown timestamps', () => {
  const session = parseSession(lines(
    { [p + 'type']: 'generation', [p + 'model.name']: 'model', timestamp: 100, [p + 'input']: { messages: [{ role: 'user' }] } },
    { [p + 'output']: [{ tool_calls: [{ id: 'missing', name: 'read' }] }], timestamp: 101 },
    { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'orphan', tool: 'read' } },
  ) + '{incomplete', 'legacy.jsonl');
  assert.equal(session.items.length, 3);
  assert.equal(session.items[0].model, 'model');
  assert.equal(session.items[0].counts.total, 0);
  assert.equal(session.items[0].tools[0].results.length, 0);
  assert.equal(session.items[2].type, 'tool');
  assert.equal(session.items[1].date, '1970-01-01T00:01:40.000Z');
  assert.equal(session.warnings.length, 2);
});

test('serves dashboard, local assets, session list and lazy history without collector logging', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'sample.jsonl'), lines({ [p + 'type']: 'generation', [p + 'input']: { messages: [{ role: 'user', content: '<script>alert(1)</script>' }] } }));
  await writeFile(join(directory, 'private.key'), 'not a session');
  const logs: string[] = [];
  const app = createApp(line => logs.push(line), directory);
  t.after(() => app.close());
  const html = await app.inject('/dashboard?session=sample.jsonl');
  assert.equal(html.statusCode, 200);
  assert.match(html.headers['content-type']!, /text\/html/);
  assert.match(html.body, /dashboard\/assets\/dashboard.js/);
  assert.equal((await app.inject('/dashboard/assets/dashboard.js')).statusCode, 200);
  assert.equal((await app.inject('/dashboard/assets/dashboard.css')).statusCode, 200);
  const list = (await app.inject('/dashboard/api/sessions')).json();
  assert.deepEqual(list.sessions.map((session: any) => session.filename), ['sample.jsonl']);
  const detail = await app.inject('/dashboard/api/session?session=sample.jsonl');
  assert.equal(detail.headers['cache-control'], 'no-store');
  assert.equal(Object.hasOwn(detail.json().items[0], 'input'), false);
  const history = (await app.inject('/dashboard/api/session?session=sample.jsonl&item=1')).json();
  assert.equal(history.input.messages[0].content, '<script>alert(1)</script>');
  assert.deepEqual(logs, []);
  for (const filename of ['../outside.jsonl', '..\\outside.jsonl', 'private.key', 'missing.jsonl', 'C:outside.jsonl']) {
    assert.equal((await app.inject(`/dashboard/api/session?session=${encodeURIComponent(filename)}`)).statusCode, 404);
  }
  assert.equal((await app.inject('/dashboard/api/session')).statusCode, 400);
  assert.equal((await app.inject('/dashboard/api/session?session=sample.jsonl&item=999')).statusCode, 404);
  assert.equal((await app.inject('/dashboard/assets/missing.js')).statusCode, 404);
});

test('session detail and library share the first user request as their title', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-title-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'conversation.jsonl'), lines(
    { [p + 'type']: 'event', [p + 'input']: [{ role: 'user', content: 'First request' }], startTimeUnixNano: '1000000000' },
    { [p + 'type']: 'event', [p + 'input']: [{ role: 'user', content: 'Follow-up request' }], startTimeUnixNano: '2000000000' },
  ));
  await writeFile(join(directory, 'empty.jsonl'), lines({ [p + 'type']: 'generation' }));
  const app = createApp(() => {}, directory);
  t.after(() => app.close());
  const list = (await app.inject('/dashboard/api/sessions')).json();
  const detail = (await app.inject('/dashboard/api/session?session=conversation.jsonl')).json();
  assert.equal(list.sessions.find((session: any) => session.filename === 'conversation.jsonl').preview, 'First request');
  assert.equal(detail.preview, 'First request');
  assert.equal(detail.filename, 'conversation.jsonl');
  assert.equal((await app.inject('/dashboard/api/session?session=empty.jsonl')).json().preview, 'No user observations recorded');
});

test('estimates complete session and library costs using the current startup pricing, without replacing recorded cost', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-pricing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'priced.jsonl'), lines(
    { [p + 'type']: 'generation', [p + 'model.name']: 'model', [p + 'metadata']: { providerID: 'provider' },
      [p + 'usage_details']: { input: 100, output: 20, reasoning: 10, cache_read: 900, cache_write: 10, total: 130 },
      [p + 'cost_details']: { total: 0.123 } },
    { [p + 'type']: 'generation', [p + 'usage_details']: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 } },
  ));
  const pricing: PricingStore = { catalog: null };
  const app = createApp(() => {}, directory, undefined, 30, pricing);
  t.after(() => app.close());
  const detail = async () => (await app.inject('/dashboard/api/session?session=priced.jsonl')).json();
  assert.equal((await detail()).stats.estimatedCost, null);
  assert.equal((await detail()).items[0].estimatedCost, null);
  assert.equal((await detail()).items[0].modelPrice, null);
  let finishPricing!: () => void;
  pricing.ready = new Promise<void>(resolve => { finishPricing = resolve; });
  const pending = detail();
  pricing.catalog = { provider: { models: { model: { cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.5 } } } } };
  finishPricing();
  await pending;
  const priced = await detail();
  assert.equal(priced.stats.cost, 0.123);
  assert.ok(Math.abs(priced.stats.estimatedCost.total - 0.000255) < 1e-12);
  assert.equal(priced.items[0].cost, 0.123);
  assert.ok(Math.abs(priced.items[0].estimatedCost.total - 0.000255) < 1e-12);
  assert.equal(priced.items[1].estimatedCost.total, 0);
  assert.deepEqual(priced.items[0].modelPrice, { input: 1, output: 2, cache_read: 0.1, cache_write: 0.5 });
  assert.deepEqual(priced.stats.estimatedCost, (await app.inject('/dashboard/api/sessions')).json().sessions[0].stats.estimatedCost);
  await writeFile(join(directory, 'unknown.jsonl'), lines({ [p + 'type']: 'generation', [p + 'model.name']: 'other',
    [p + 'metadata']: { providerID: 'provider' }, [p + 'usage_details']: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 } }));
  assert.equal((await app.inject('/dashboard/api/sessions')).json().sessions.find((session: any) => session.filename === 'unknown.jsonl').stats.estimatedCost, null);
  const incomplete = parseSession(lines(
    { [p + 'type']: 'generation', [p + 'model.name']: 'model', [p + 'metadata']: { providerID: 'provider' },
      [p + 'usage_details']: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 } },
    { [p + 'type']: 'generation', [p + 'usage_details']: { input: 1, output: 1, cache_read: 0, cache_write: 0 } },
  ), 'incomplete.jsonl', pricing.catalog);
  assert.equal(incomplete.stats.estimatedCost, null);
  assert.notEqual(incomplete.items[0].estimatedCost, null);
  assert.equal(incomplete.items[1].estimatedCost, null);
  assert.deepEqual(incomplete.items[1].modelPrice, { input: 1, output: 2, cache_read: 0.1, cache_write: 0.5 });
});

test('a new workspace with no data directory has an empty library', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createApp(() => {}, join(directory, 'missing'));
  t.after(() => app.close());
  assert.deepEqual((await app.inject('/dashboard/api/sessions')).json(), { sessions: [] });
});
