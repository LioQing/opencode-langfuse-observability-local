export async function fetchModelPricing(fetcher = fetch) {
    const response = await fetcher('https://models.dev/api.json', { signal: AbortSignal.timeout(10000) });
    if (!response.ok)
        throw new Error(`models.dev returned ${response.status}`);
    const catalog = await response.json();
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog))
        throw new Error('Invalid models.dev catalog');
    return catalog;
}
function modelRates(catalog, provider, model, usage) {
    if (!catalog || !provider || !model)
        return null;
    const cost = catalog[provider]?.models?.[model]?.cost;
    if (!cost)
        return null;
    const context = usage.input === null || usage.cache_read === null || usage.cache_write === null ? null : usage.input + usage.cache_read + usage.cache_write;
    const tiers = (Array.isArray(cost.tiers) ? cost.tiers : []).filter(value => value.tier?.type === 'context' && typeof value.tier.size === 'number');
    if (context === null && tiers.length)
        return null;
    const tier = tiers.filter(value => context !== null && context > value.tier.size)
        .sort((a, b) => b.tier.size - a.tier.size)[0];
    return { ...cost, ...tier };
}
export function modelPrice(catalog, provider, model, usage) {
    const rates = modelRates(catalog, provider, model, usage);
    if (!rates)
        return null;
    const valid = (rate) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : null;
    return { input: valid(rates.input), output: valid(rates.output), cache_read: valid(rates.cache_read), cache_write: valid(rates.cache_write) };
}
export function estimateGeneration(catalog, provider, model, usage) {
    if (['input', 'output', 'reasoning', 'cache_read', 'cache_write'].some(key => usage[key] === null))
        return null;
    const rates = modelRates(catalog, provider, model, usage);
    if (!rates)
        return null;
    const charge = (tokens, rate) => tokens === 0 ? 0 : typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? tokens * rate / 1e6 : null;
    const input = charge(usage.input, rates.input);
    const outputTokens = charge(usage.output, rates.output);
    const reasoning = charge(usage.reasoning, rates.reasoning ?? rates.output);
    const cache_read = charge(usage.cache_read, rates.cache_read);
    const cache_write = charge(usage.cache_write, rates.cache_write);
    if (input === null || outputTokens === null || reasoning === null || cache_read === null || cache_write === null)
        return null;
    const output = outputTokens + reasoning;
    return { input, output, reasoning, cache_read, cache_write, total: input + output + cache_read + cache_write };
}
export function sumEstimates(estimates) {
    if (!estimates.length || estimates.some(value => value === null))
        return null;
    return estimates.reduce((total, value) => ({
        input: total.input + value.input, output: total.output + value.output, reasoning: total.reasoning + value.reasoning,
        cache_read: total.cache_read + value.cache_read, cache_write: total.cache_write + value.cache_write,
        total: total.total + value.total,
    }), { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 });
}
