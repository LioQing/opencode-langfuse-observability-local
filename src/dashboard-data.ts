import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateGeneration, modelPrice, sumEstimates } from './model-pricing.js';
import type { ModelPricing } from './model-pricing.js';

type RecordValue = Record<string, any>;
const prefix = 'langfuse.observation.';
const record = (value: any): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value: any): any[] => Array.isArray(value) ? value : [];
const numeric = (value: any): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export const usageKeys = ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'total'] as const;

function time(entry: RecordValue): bigint | null {
  try {
    if (typeof entry.startTimeUnixNano === 'string' && /^\d+$/.test(entry.startTimeUnixNano)) return BigInt(entry.startTimeUnixNano);
    if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) return BigInt(Math.round(entry.timestamp * 1e9));
  } catch { /* Invalid times stay explicitly unknown. */ }
  return null;
}

export function textContent(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return textContent(value.text ?? value.content ?? value.output ?? '');
  return '';
}

function callsIn(output: any): RecordValue[] {
  return array(output).flatMap(message => [
    ...array(message?.tool_calls),
    ...array(message?.content).filter(part => part?.type === 'tool-call' || part?.type === 'tool_use'),
  ]).map(call => ({ ...call, id: call.id ?? call.toolCallId, name: call.name ?? call.toolName ?? call.function?.name, arguments: call.arguments ?? call.input ?? call.args ?? call.function?.arguments }));
}

function outputCounts(output: any) {
  if (output == null) return { responses: null, reasoning: null };
  const messages = Array.isArray(output) ? output : [output];
  return {
    responses: messages.filter(message => {
      const content = message?.content;
      return Boolean(textContent(Array.isArray(content) ? content.filter(part => part?.type !== 'reasoning' && part?.type !== 'thinking') : content ?? message?.text ?? message?.output ?? message));
    }).length,
    reasoning: messages.filter(message => Boolean(textContent(message?.thinking)) || message?.type === 'reasoning' || message?.type === 'thinking' || array(message?.content).some(part => part?.type === 'reasoning' || part?.type === 'thinking')).length,
  };
}

export function parseSession(content: string, filename: string, catalog: ModelPricing | null = null) {
  const warnings: string[] = [];
  const entries: { entry: RecordValue; id: number; time: bigint | null }[] = [];
  let state: RecordValue = {};
  content.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object');
      let entry = raw;
      const type = raw[prefix + 'type'] ?? 'generation';
      if (type === 'generation') {
        const input = record(raw[prefix + 'input']);
        state = {
          ...state,
          ...Object.fromEntries(Object.entries(raw).filter(([key]) => !['input', 'output', 'usage_details', 'cost_details'].some(suffix => key === prefix + suffix) && !['startTimeUnixNano', 'endTimeUnixNano', 'timestamp'].includes(key))),
          [prefix + 'metadata']: { ...record(state[prefix + 'metadata']), ...record(raw[prefix + 'metadata']) },
          [prefix + 'input']: { ...record(state[prefix + 'input']), ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'messages')) },
        };
        entry = { ...state, ...raw, [prefix + 'type']: type, [prefix + 'metadata']: state[prefix + 'metadata'],
          [prefix + 'input']: { ...state[prefix + 'input'], ...input } };
      }
      entries.push({ entry, id: index + 1, time: time(entry) });
    } catch {
      warnings.push(`Line ${index + 1} could not be read. It may be incomplete or invalid JSON.`);
    }
  });
  const toolIndex = new Map<string, typeof entries>();
  for (const row of entries) {
    if (row.entry[prefix + 'type'] !== 'tool') continue;
    const metadata = record(row.entry[prefix + 'metadata']);
    const id = metadata.callID ?? metadata.toolCallId ?? metadata.tool_call_id;
    if (typeof id === 'string') toolIndex.set(id, [...(toolIndex.get(id) ?? []), row]);
  }
  const attached = new Set<number>();
  const recordedCallResults = new Set<number>();
  const items = entries.filter(({ entry }) => ['generation', 'event', 'user', 'tool'].includes(entry[prefix + 'type'])).map(row => {
    const { entry, id, time: timestamp } = row;
    const type = entry[prefix + 'type'] === 'event' ? 'user' : entry[prefix + 'type'];
    const metadata = record(entry[prefix + 'metadata']);
    const input = entry[prefix + 'input'];
    const output = entry[prefix + 'output'];
    const messages = Array.isArray(input) ? input : array(input?.messages);
    const calls = callsIn(output);
    const tools = calls.map(call => {
      const matches = typeof call.id === 'string' ? toolIndex.get(call.id) ?? [] : [];
      matches.forEach(match => { attached.add(match.id); recordedCallResults.add(match.id); });
      return { ...call, id: call.id, name: call.name, arguments: call.arguments, inferred: false, results: matches.map(match => ({ id: match.id, input: match.entry[prefix + 'input'], output: match.entry[prefix + 'output'], start: match.entry.startTimeUnixNano, end: match.entry.endTimeUnixNano })) };
    });
    const rawUsage = record(entry[prefix + 'usage_details']);
    const usage = Object.fromEntries(usageKeys.map(key => [key, numeric(rawUsage[key])])) as Record<typeof usageKeys[number], number | null>;
    // The plugin stores uncached input and excludes cache tokens from its reported total.
    const reportedTotal = usage.total;
    usage.total = reportedTotal === null ? null : reportedTotal + (usage.cache_read ?? 0) + (usage.cache_write ?? 0);
    const uncached = usage.input;
    const inputTotal = (usage.input ?? 0) + (usage.cache_read ?? 0) + (usage.cache_write ?? 0);
    const cacheHit = usage.input === null || usage.cache_read === null ? null : inputTotal === 0 ? 0 : usage.cache_read / inputTotal;
    let duration: number | null = null;
    try { if (timestamp !== null && entry.endTimeUnixNano) duration = Math.max(0, Number(BigInt(entry.endTimeUnixNano) - timestamp) / 1e6); } catch {}
    const reasoning = array(output).some(message => textContent(message.thinking) || array(message.content).some(part => part.type === 'reasoning')) || (usage.reasoning ?? 0) > 0;
    const response = Boolean(textContent(output));
    const summary = type === 'user' ? textContent(input) || 'User observation'
      : type === 'tool' ? `Tool · ${metadata.tool ?? 'unknown'}`
        : [reasoning ? 'Reasoning' : '', ...calls.map(call => `tool(${call.name ?? 'unknown'})`), response ? 'Response' : ''].filter(Boolean).join(' + ') || 'Generation';
    return { id, type, timestamp: timestamp?.toString() ?? null, date: timestamp === null ? null : new Date(Number(timestamp / 1000000n)).toISOString(), duration,
      provider: metadata.providerID ?? null, model: entry[prefix + 'model.name'] ?? null, variant: metadata.variant ?? null, mode: metadata.mode ?? metadata.agent ?? null,
      counts: { total: messages.length, assistant: messages.filter(message => message?.role === 'assistant').length, user: messages.filter(message => message?.role === 'user').length, tool: messages.filter(message => message?.role === 'tool').length, toolCalls: calls.length },
      outputCounts: outputCounts(output),
      usage, reportedTotal, uncached, cacheHit, cost: numeric(record(entry[prefix + 'cost_details']).total), costDetails: entry[prefix + 'cost_details'] ?? null,
      estimatedCost: type === 'generation' ? estimateGeneration(catalog, metadata.providerID ?? null, entry[prefix + 'model.name'] ?? null, usage) : null,
      modelPrice: type === 'generation' ? modelPrice(catalog, metadata.providerID ?? null, entry[prefix + 'model.name'] ?? null, usage) : null,
      summary, reasoning, response, output: type === 'user' ? input : output ?? null, tools, input, metadata };
  });
  // A tool result may be recorded even when its generation output omits tool_calls.
  // Infer only when both complete intervals identify exactly one generation.
  for (const row of entries) {
    if (row.entry[prefix + 'type'] !== 'tool' || attached.has(row.id)) continue;
    const start = row.time;
    const end = time({ startTimeUnixNano: row.entry.endTimeUnixNano });
    if (start === null || end === null || end < start) continue;
    const candidates = entries.filter(candidate => {
      if (candidate.entry[prefix + 'type'] !== 'generation') return false;
      const finish = time({ startTimeUnixNano: candidate.entry.endTimeUnixNano });
      return candidate.time !== null && finish !== null && finish >= candidate.time && candidate.time <= start && end <= finish;
    });
    if (candidates.length !== 1) continue;
    const generation = items.find(item => item.id === candidates[0].id)!;
    const metadata = record(row.entry[prefix + 'metadata']);
    const name = typeof metadata.tool === 'string' ? metadata.tool : 'unknown';
    const callID = metadata.callID ?? metadata.toolCallId ?? metadata.tool_call_id;
    generation.tools.push({ id: typeof callID === 'string' ? callID : null, name, arguments: null, inferred: true,
      results: [{ id: row.id, input: row.entry[prefix + 'input'], output: row.entry[prefix + 'output'], start: row.entry.startTimeUnixNano, end: row.entry.endTimeUnixNano }] });
    generation.summary = `${generation.summary === 'Generation' ? '' : generation.summary + ' + '}tool(${name})`;
    attached.add(row.id);
  }
  const visibleItems = items.filter(item => item.type !== 'tool' || !attached.has(item.id));
  visibleItems.sort((a, b) => {
    if (a.timestamp === null || b.timestamp === null) return a.timestamp === b.timestamp ? a.id - b.id : a.timestamp === null ? 1 : -1;
    const delta = BigInt(b.timestamp) - BigInt(a.timestamp);
    return delta < 0n ? -1 : delta > 0n ? 1 : a.id - b.id;
  });
  if (visibleItems.some(item => item.timestamp === null)) warnings.push('Observations without timestamps appear last, in file order.');
  const generations = visibleItems.filter(item => item.type === 'generation');
  const sum = (values: (number | null)[]) => values.some(value => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
  const usage = Object.fromEntries(usageKeys.map(key => [key, sum(generations.map(item => item.usage[key]))])) as Record<typeof usageKeys[number], number | null>;
  const times = entries.flatMap(row => row.time === null ? [] : [row.time]);
  const durationMs = times.length < 2 ? null : Number(
    times.reduce((latest, value) => value > latest ? value : latest) - times.reduce((earliest, value) => value < earliest ? value : earliest)
  ) / 1e6;
  const generationDurations = generations.map(item => item.duration);
  const generationDurationMs = sum(generationDurations);
  const estimatedCost = sumEstimates(generations.map(item => item.estimatedCost));
  const stats = { generations: generations.length, users: visibleItems.filter(item => item.type === 'user').length,
    // Output calls may have matching tool observations; count those only once.
    // Other tool observations are still real calls even if output omitted tool_calls.
    toolCalls: generations.reduce((total, item) => total + item.counts.toolCalls, 0)
      + entries.filter(row => row.entry[prefix + 'type'] === 'tool' && !recordedCallResults.has(row.id)).length, usage,
    cost: sum(generations.map(item => item.cost)), estimatedCost, reportedTotal: sum(generations.map(item => item.reportedTotal)), cacheHit: usage.input === null || usage.cache_read === null ? null : (usage.input + usage.cache_read + (usage.cache_write ?? 0)) ? usage.cache_read / (usage.input + usage.cache_read + (usage.cache_write ?? 0)) : 0,
    models: [...new Set(generations.map(item => item.model).filter(Boolean))] as string[],
    missingUsage: generations.filter(item => item.usage.total === null).length, missingCost: generations.filter(item => item.cost === null).length,
    durationMs, durationPartial: times.length < entries.length,
    generationDurationMs, generationDurationPartial: generationDurations.some(value => value === null) };
  const preview = visibleItems.filter(item => item.type === 'user').at(-1)?.summary.slice(0, 220) ?? 'No user observations recorded';
  return { filename, preview, items: visibleItems, stats, warnings, observations: entries.length };
}

export async function sessionFiles(directory: string) {
  try {
    const files = await readdir(directory, { withFileTypes: true });
    return files.filter(file => file.isFile() && file.name.endsWith('.jsonl')).map(file => file.name).sort().reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function loadSession(directory: string, filename: string, catalog: ModelPricing | null = null) {
  if (!filename.endsWith('.jsonl') || /[/\\:\0]/.test(filename) || filename === '.jsonl') return null;
  try {
    const path = join(directory, filename);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const session = parseSession(await readFile(path, 'utf8'), filename, catalog);
    return { ...session, bytes: stat.size, modified: stat.mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export type Session = NonNullable<Awaited<ReturnType<typeof loadSession>>>;
export type Item = Session['items'][number];
