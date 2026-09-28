import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateGeneration, fetchModelPricing, modelPrice, sumEstimates } from './model-pricing.js';
import type { ModelPricing } from './model-pricing.js';

const catalog: ModelPricing = { provider: { models: { model: { cost: {
  input: 1, output: 2, reasoning: 3, cache_read: 0.1, cache_write: 0.5,
  tiers: [{ tier: { type: 'context', size: 200000 }, input: 4, output: 5, reasoning: 6, cache_read: 0.2, cache_write: 1 }],
} } } } };
const usage = { input: 100, output: 20, reasoning: 10, cache_read: 900, cache_write: 10 };
const near = (value: number | undefined, expected: number) => assert.ok(value !== undefined && Math.abs(value - expected) < 1e-12);

test('loads models.dev pricing once from its JSON API and reports failures', async () => {
  let calls = 0;
  const fetcher = (async (url: string, options: RequestInit) => {
    calls++;
    assert.equal(url, 'https://models.dev/api.json');
    assert.ok(options.signal);
    return new Response(JSON.stringify(catalog), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await fetchModelPricing(fetcher), catalog);
  assert.equal(calls, 1);
  await assert.rejects(fetchModelPricing((async () => new Response('', { status: 503 })) as typeof fetch), /503/);
});

test('estimates per-category cost from exact provider/model pricing, with reasoning included in output', () => {
  const estimate = estimateGeneration(catalog, 'provider', 'model', usage);
  near(estimate?.input, 0.0001);
  near(estimate?.output, 0.00007);
  near(estimate?.reasoning, 0.00003);
  near(estimate?.cache_read, 0.00009);
  near(estimate?.cache_write, 0.000005);
  near(estimate?.total, 0.000265);
  const doubled = sumEstimates([estimate, estimate]);
  near(doubled?.input, 0.0002);
  near(doubled?.output, 0.00014);
  near(doubled?.reasoning, 0.00006);
  near(doubled?.cache_read, 0.00018);
  near(doubled?.cache_write, 0.00001);
  near(doubled?.total, 0.00053);
  assert.equal(estimateGeneration(catalog, 'other', 'model', usage), null);
  assert.equal(estimateGeneration(catalog, 'provider', 'other', usage), null);
  assert.equal(estimateGeneration(catalog, 'provider', 'model', { ...usage, reasoning: null }), null);
  assert.equal(estimateGeneration({ provider: { models: { model: { cost: { input: 1, output: 2 } } } } }, 'provider', 'model', usage), null);
  assert.equal(sumEstimates([estimate, null]), null);
  assert.equal(sumEstimates([]), null);
});

test('uses context tiers and recognizes free models and zero-valued usage', () => {
  const highUsage = { input: 50000, output: 20, reasoning: 10, cache_read: 160000, cache_write: 0 };
  const estimate = estimateGeneration(catalog, 'provider', 'model', highUsage);
  assert.equal(estimate?.input, 0.2);
  assert.equal(estimate?.output, 0.00016);
  assert.equal(estimate?.cache_read, 0.032);
  assert.deepEqual(estimateGeneration({ provider: { models: { free: { cost: { input: 0, output: 0 } } } } }, 'provider', 'free', {
    input: 1, output: 2, reasoning: 0, cache_read: 0, cache_write: 0,
  }), { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 });
});

test('shows the selected per-million model rates independently of cost estimates', () => {
  assert.deepEqual(modelPrice(catalog, 'provider', 'model', usage), { input: 1, output: 2, cache_read: 0.1, cache_write: 0.5 });
  assert.deepEqual(modelPrice(catalog, 'provider', 'model', { ...usage, input: 50000, cache_read: 160000 }), { input: 4, output: 5, cache_read: 0.2, cache_write: 1 });
  assert.equal(modelPrice(catalog, 'provider', 'model', { ...usage, cache_read: null }), null);
  assert.deepEqual(modelPrice({ provider: { models: { model: { cost: { input: 1, output: 2 } } } } }, 'provider', 'model', { ...usage, reasoning: null }),
    { input: 1, output: 2, cache_read: null, cache_write: null });
  assert.equal(modelPrice(null, 'provider', 'model', usage), null);
});
