// models.dev publishes prices in USD per million tokens, keyed by provider and model ID.
type Rates = { input?: number; output?: number; reasoning?: number; cache_read?: number; cache_write?: number };
type ModelCost = Rates & { tiers?: (Rates & { tier?: { type?: string; size?: number } })[] };
export type ModelPricing = Record<string, { models?: Record<string, { cost?: ModelCost }> }>;
export type ModelPrice = Record<'input' | 'output' | 'cache_read' | 'cache_write', number | null>;
export type CostEstimate = { input: number; output: number; reasoning: number; cache_read: number; cache_write: number; total: number };
export type PricingStore = { catalog: ModelPricing | null; ready?: Promise<void> };

export async function fetchModelPricing(fetcher: typeof fetch = fetch): Promise<ModelPricing> {
  const response = await fetcher('https://models.dev/api.json', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
  const catalog: unknown = await response.json();
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('Invalid models.dev catalog');
  return catalog as ModelPricing;
}

function modelRates(
  catalog: ModelPricing | null,
  provider: string | null,
  model: string | null,
  usage: Record<'input' | 'output' | 'reasoning' | 'cache_read' | 'cache_write', number | null>,
): Rates | null {
  if (!catalog || !provider || !model) return null;
  const cost = catalog[provider]?.models?.[model]?.cost;
  if (!cost) return null;
  const context = usage.input === null || usage.cache_read === null || usage.cache_write === null ? null : usage.input + usage.cache_read + usage.cache_write;
  const tiers = (Array.isArray(cost.tiers) ? cost.tiers : []).filter(value => value.tier?.type === 'context' && typeof value.tier.size === 'number');
  if (context === null && tiers.length) return null;
  const tier = tiers.filter(value => context !== null && context > value.tier!.size!)
    .sort((a, b) => b.tier!.size! - a.tier!.size!)[0];
  return { ...cost, ...tier };
}

export function modelPrice(
  catalog: ModelPricing | null,
  provider: string | null,
  model: string | null,
  usage: Record<'input' | 'output' | 'reasoning' | 'cache_read' | 'cache_write', number | null>,
): ModelPrice | null {
  const rates = modelRates(catalog, provider, model, usage);
  if (!rates) return null;
  const valid = (rate: number | undefined) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : null;
  return { input: valid(rates.input), output: valid(rates.output), cache_read: valid(rates.cache_read), cache_write: valid(rates.cache_write) };
}

export function estimateGeneration(
  catalog: ModelPricing | null,
  provider: string | null,
  model: string | null,
  usage: Record<'input' | 'output' | 'reasoning' | 'cache_read' | 'cache_write', number | null>,
): CostEstimate | null {
  if ((['input', 'output', 'reasoning', 'cache_read', 'cache_write'] as const).some(key => usage[key] === null)) return null;
  const rates = modelRates(catalog, provider, model, usage);
  if (!rates) return null;
  const charge = (tokens: number, rate: number | undefined) => tokens === 0 ? 0 : typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? tokens * rate / 1e6 : null;
  const input = charge(usage.input!, rates.input);
  const outputTokens = charge(usage.output!, rates.output);
  const reasoning = charge(usage.reasoning!, rates.reasoning ?? rates.output);
  const cache_read = charge(usage.cache_read!, rates.cache_read);
  const cache_write = charge(usage.cache_write!, rates.cache_write);
  if (input === null || outputTokens === null || reasoning === null || cache_read === null || cache_write === null) return null;
  const output = outputTokens + reasoning;
  return { input, output, reasoning, cache_read, cache_write, total: input + output + cache_read + cache_write };
}

export function sumEstimates(estimates: (CostEstimate | null)[]): CostEstimate | null {
  if (!estimates.length || estimates.some(value => value === null)) return null;
  return estimates.reduce<CostEstimate>((total, value) => ({
    input: total.input + value!.input, output: total.output + value!.output, reasoning: total.reasoning + value!.reasoning,
    cache_read: total.cache_read + value!.cache_read, cache_write: total.cache_write + value!.cache_write,
    total: total.total + value!.total,
  }), { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 });
}
