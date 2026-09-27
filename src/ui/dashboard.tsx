import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-600.css';
import './dashboard.css';
import type { Session, Item } from '../dashboard-data.js';

gsap.registerPlugin(ScrollTrigger, useGSAP);
type SessionView = Omit<Session, 'items'> & { items: Omit<Item, 'input'>[] };
type Observation = SessionView['items'][number];
type LibraryEntry = Pick<Session, 'filename' | 'bytes' | 'modified' | 'stats' | 'warnings' | 'observations'> & { preview: string };
const format = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat().format(value);
const compact = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const percent = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const money = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
const duration = (ms: number | null) => {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remaining = seconds % 60;
  return [days && `${days}d`, (days || hours) && `${hours}h`, (days || hours || minutes) && `${minutes}m`, `${remaining}s`].filter(Boolean).join(' ');
};
const date = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Time unavailable';
const pretty = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'Not recorded';
const usageLabels = { input: 'Input', output: 'Output', reasoning: 'Reasoning', reportedTotal: 'Subtotal excl. cache', cache_read: 'Cached input', cache_write: 'Cached output', total: 'Total incl. cache' };
const usageColors = { input: '#c3ee8c', output: '#a8b9fa', cache_read: '#62cbb4', cache_write: '#e5c58d', reasoning: '#ca9ce1', total: '#eceee9' };
type Usage = Item['usage'];
const usageCategories = ['input', 'output', 'reasoning', 'cache_read', 'cache_write'] as const;

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    back: <path d="M19 12H5m6-6-6 6 6 6" />,
    up: <path d="m6 14 6-6 6 6M12 8v13" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
    user: <><circle cx="12" cy="8" r="3" /><path d="M5 20v-2a7 7 0 0 1 14 0v2" /></>,
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /></>,
    response: <path d="M4 5h16v12H9l-5 4V5ZM8 9h8M8 13h5" />,
    file: <><path d="M14 3H5v18h14V8l-5-5v5h5M8 12h8M8 16h6" /></>,
    tool: <><path d="m14 5 5 5M3 21l9-9M15 3l6 6-5 5-6-6Z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.spark}</svg>;
}

function Signal() {
  return <span className="signal" aria-hidden="true">{Array.from({ length: 15 }, (_, i) => <i key={i} style={{ height: `${20 + Math.sin(i * 1.9) ** 2 * 70}%` }} />)}</span>;
}

function Metrics({ stats, library }: { stats: Session['stats']; library?: number }) {
  return <div className={`metrics${library == null ? ' session-metrics' : ''}`}>
    <div className={`metric${library == null ? ' generations-metric' : ''}`}><span>{library == null ? 'Generations' : 'Sessions recorded'}</span><strong>{format(library ?? stats.generations)}{library != null && <small>{format(stats.generations)} generations</small>}</strong><div className="metric-bottom">{library == null ? `${format(stats.users)} user ${stats.users === 1 ? 'request' : 'requests'}, ${format(stats.toolCalls)} tool ${stats.toolCalls === 1 ? 'call' : 'calls'}` : <><span className="dot" />{format(stats.toolCalls)} tool calls</>}</div></div>
    <div className="metric"><span>Total tokens</span><strong>{compact(stats.usage.total)}</strong><div className="metric-bottom">{format(stats.usage.total)} recorded{stats.missingUsage > 0 ? ' · partial' : ''}</div></div>
    <div className="metric"><span>Input cache hit</span><strong>{percent(stats.cacheHit)}</strong><div className="meter"><i style={{ width: `${Math.min(100, (stats.cacheHit ?? 0) * 100)}%` }} /></div><div className="metric-bottom">{compact(stats.usage.cache_read)} cached input tokens</div></div>
    <div className="metric"><span>Recorded cost <small>USD</small></span><strong>{money(stats.cost)}</strong><div className="metric-bottom">{stats.missingCost ? `${stats.missingCost} generations without cost` : 'Across all generations'}</div></div>
    {library == null && <div className="metric"><span>Total duration</span><strong>{duration(stats.durationMs)}</strong><div className="metric-bottom">First to last observation{stats.durationPartial && stats.durationMs !== null ? ' · partial timestamps' : ''}</div></div>}
  </div>;
}

function UsageTable({ usage, reportedTotal }: { usage: Usage; reportedTotal: number | null }) {
  const [activeCategory, setActiveCategory] = useState<typeof usageCategories[number] | null>(null);
  const activeValue = activeCategory === null ? null : usage[activeCategory];
  const activeRatio = activeValue == null || usage.total == null ? null : usage.total ? activeValue / usage.total : 0;
  return <div className="usage-table"><div className="usage-row table-head"><span>Token category</span><span>Tokens</span><span>% of total</span></div>
    {Object.entries(usageLabels).map(([key, label]) => {
      const value = key === 'reportedTotal' ? reportedTotal : usage[key as keyof Usage];
      const ratio = value == null || usage.total == null ? null : usage.total ? value / usage.total : 0;
      return <div className={`usage-row${key === 'reportedTotal' ? ' subtotal-row' : key === 'total' ? ' total-row' : ''}`} key={key}><span>{key !== 'reportedTotal' && key !== 'total' && <i style={{ background: usageColors[key as keyof Usage] }} />}{label}</span><span>{format(value)}</span><span>{percent(ratio)}</span></div>;
    })}
    <div className="usage-bar-wrap">
      <div className="usage-bar" role="group" aria-label="Token composition by category">
        {usage.total != null && usage.total > 0 && usageCategories.map(key => {
          const value = usage[key];
          if (value == null || value <= 0) return null;
          const ratio = value / usage.total!;
          return <button type="button" className="usage-segment" key={key} style={{ width: `${ratio * 100}%`, background: usageColors[key] }} aria-label={`${usageLabels[key]}: ${format(value)} tokens, ${percent(ratio)} of total`} onMouseEnter={() => setActiveCategory(key)} onMouseLeave={() => setActiveCategory(null)} onFocus={() => setActiveCategory(key)} onBlur={() => setActiveCategory(null)} />;
        })}
      </div>
      {activeCategory && <div className="usage-tooltip" role="tooltip"><strong>{usageLabels[activeCategory]}</strong><span>{format(activeValue)} tokens · {percent(activeRatio)} of total</span></div>}
    </div>
  </div>;
}

function Analytics({ session, onSelect }: { session: SessionView; onSelect: (id: number) => void }) {
  const [measure, setMeasure] = useState<'total' | 'uncached' | 'cost'>('total');
  const generations = session.items.filter(item => item.type === 'generation').reverse();
  const value = (item: Observation) => measure === 'total' ? item.usage.total : item[measure];
  const max = Math.max(1, ...generations.map(item => value(item) ?? 0));
  return <section className="analytics chapter" aria-label="Session analytics"><div className="section-heading"><div><span className="eyebrow">The bigger picture</span><h2>Every token tells a story.</h2></div><span className="subtle">Select a bar to inspect its generation</span></div>
    <div className="analytics-panels">
      <div className="analysis-panel volume-panel"><div className="panel-heading"><span className="panel-title">Generation footprint</span><select aria-label="Chart measure" value={measure} onChange={event => setMeasure(event.target.value as typeof measure)}><option value="total">Total tokens</option><option value="uncached">Uncached input</option><option value="cost">Cost (USD)</option></select></div>
        <div className="chart-label"><span>{measure === 'cost' ? money(max === 1 && generations.every(item => !item.cost) ? 0 : max) : format(max)}</span><span>{generations.length} generations</span></div>
        <div className="bar-chart" role="group" aria-label={`${measure} by generation, chronological order`}>
          {generations.length ? generations.map((item, index) => <button key={item.id} className="chart-column" onClick={() => onSelect(item.id)} title={`Generation ${index + 1} · ${date(item.date)} · ${measure === 'cost' ? money(item.cost) : format(value(item))}`} aria-label={`Inspect generation ${index + 1}: ${measure === 'cost' ? money(item.cost) : format(value(item))} ${measure}`}><span className={value(item) === null ? 'unknown-bar' : ''} style={{ height: `${Math.max(2, (value(item) ?? 0) / max * 100)}%` }} /></button>) : <p className="subtle">No generations recorded yet.</p>}
        </div><div className="chart-label"><span>First generation</span><span>Latest generation</span></div>
      </div>
       <div className="analysis-panel mix-panel"><div className="panel-heading"><span className="panel-title">Token composition</span></div><UsageTable usage={session.stats.usage} reportedTotal={session.stats.reportedTotal} /></div>
    </div>
  </section>;
}

function Content({ value }: { value: any }) {
  if (value == null) return <p className="subtle">No output recorded.</p>;
  if (typeof value === 'string') return value ? <MarkdownText text={value} /> : null;
  if (Array.isArray(value)) return <>{value.map((part, index) => <Content key={index} value={part} />)}</>;
  if (typeof value !== 'object') return <pre>{pretty(value)}</pre>;
  if (value.role || value.type === 'text' || value.type === 'thinking' || value.type === 'reasoning') {
    return <div className="message-content">{value.thinking && <details className="nested reasoning"><summary>Reasoning</summary><Content value={value.thinking} /></details>}
      <Content value={value.text ?? value.content} />
      {value.tool_calls?.length > 0 && <div className="call-list">{value.tool_calls.map((call: any, i: number) => <div className="call" key={i}><div><Icon name="tool" /><strong>{call.name ?? call.function?.name ?? 'Tool call'}</strong><code>{call.id}</code></div><pre>{prettyArguments(call.arguments ?? call.function?.arguments)}</pre></div>)}</div>}
    </div>;
  }
  if (typeof value.output === 'string') return <MarkdownText text={value.output} />;
  return <pre>{pretty(value)}</pre>;
}

function MarkdownText({ text }: { text: string }) {
  const [view, setView] = useState<'markdown' | 'raw'>('markdown');
  return <div className="text-content">
    <div className="text-view-toggle" role="group" aria-label="Text display mode">
      <button type="button" aria-pressed={view === 'markdown'} onClick={() => setView('markdown')}>Markdown</button>
      <button type="button" aria-pressed={view === 'raw'} onClick={() => setView('raw')}>Raw</button>
    </div>
    {view === 'raw' ? <pre><code>{text}</code></pre> : <div className="prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      img: ({ alt }) => <span className="subtle">[Image: {alt || 'attachment'}]</span>,
    }}>{text}</Markdown></div>}
  </div>;
}

function prettyArguments(value: unknown) {
  if (typeof value === 'string') { try { return pretty(JSON.parse(value)); } catch {} }
  return pretty(value);
}

function RawHistory({ filename, id }: { filename: string; id: number }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open || data) return;
    const controller = new AbortController();
    setError('');
    getJSON(`/dashboard/api/session?session=${encodeURIComponent(filename)}&item=${id}`, controller.signal).then(setData).catch(error => { if (error.name !== 'AbortError') setError(error.message); });
    return () => controller.abort();
  }, [open, filename, id, retry]);
  return <details className="nested raw-history" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><Icon name="file" />Raw message history <span>Input, system & tool definitions</span></summary>
    {open && (error ? <div role="alert">{error} <button onClick={() => setRetry(retry + 1)}>Retry</button></div> : data ? <pre>{pretty(data.input)}</pre> : <p className="subtle">Loading history…</p>)}
  </details>;
}

function ObservationCard({ item, filename, open, onToggle }: { item: Observation; filename: string; open: boolean; onToggle: () => void }) {
  const generation = item.type === 'generation';
  return <article id={`observation-${item.id}`} className={`observation ${open ? 'is-open' : ''} ${item.type}`}>
    <button className="observation-summary" aria-expanded={open} aria-controls={`body-${item.id}`} onClick={onToggle}>
       <span className="type-icons" aria-hidden="true">{generation ? <>
         {item.reasoning && <span className="type-icon generation"><Icon name="spark" /></span>}
         {item.response && <span className="type-icon response"><Icon name="response" /></span>}
         {item.tools.length > 0 && <span className="type-icon tool"><Icon name="tool" /></span>}
         {!item.reasoning && !item.response && item.tools.length === 0 && <span className="type-icon generation"><Icon name="file" /></span>}
       </> : <span className={`type-icon ${item.type}`}><Icon name={item.type === 'user' ? 'user' : 'tool'} /></span>}</span>
      <span className="observation-title"><span className="row-label">{generation ? item.model ?? 'Generation' : item.type === 'user' ? 'You' : 'Tool result'}{generation && item.mode && <span>{item.mode}</span>}</span><span className="summary-text">{item.summary}</span></span>
       {generation && <span className="row-usage"><span>{compact(item.uncached)}<small>Input</small></span><span>{compact(item.usage.output)}<small>Output</small></span></span>}
      <time dateTime={item.date ?? undefined} title={item.timestamp ? `${item.timestamp} ns` : undefined}>{date(item.date)}</time><span className="expand-icon"><Icon name="chevron" size={15} /></span>
    </button>
    {open && <div className="observation-body" id={`body-${item.id}`}>
      {generation && <><div className="identity-grid">{[['Provider', item.provider], ['Model', item.model], ['Variant', item.variant], ['Mode', item.mode]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value ?? 'Not recorded'}</strong></div>)}</div>
           <div className="generation-grid"><div><h3>Context & execution</h3><h4 className="count-heading">Input history</h4><div className="count-grid">{([['Messages', item.counts.total], ['Assistant', item.counts.assistant], ['User', item.counts.user], ['Tool', item.counts.tool]] as [string, number][]).map(([label, value]) => <div key={label}><strong>{format(value)}</strong><span>{label}</span></div>)}</div><p className="note">Other roles may also appear in the input total.</p><h4 className="count-heading">Generation output</h4><div className="count-grid">{([['Tool calls', item.output == null ? null : item.counts.toolCalls], ['Tool results', item.tools.reduce((total, tool) => total + tool.results.length, 0)], ['Responses', item.outputCounts.responses], ['Reasoning', item.outputCounts.reasoning]] as [string, number | null][]).map(([label, value]) => <div key={label}><strong>{format(value)}</strong><span>{label}</span></div>)}</div><p className="note">Responses and reasoning count messages with text or thinking, not tokens. Tool results count linked observations. A dash means output was not recorded.</p><div className="execution"><div><span>Cache hit</span><strong>{percent(item.cacheHit)}</strong></div><div><span>Cost · USD</span><strong>{money(item.cost)}</strong></div><div><span>Duration</span><strong>{item.duration == null ? '—' : `${(item.duration / 1000).toFixed(2)}s`}</strong></div></div><p className="note">Cache hit = cache read ÷ (input + cache read + cache write). Input is already uncached. A dash means not recorded.</p>{item.costDetails && <details className="nested"><summary>Cost breakdown</summary><pre>{pretty(item.costDetails)}</pre></details>}</div><div><h3>Token usage</h3><UsageTable usage={item.usage} reportedTotal={item.reportedTotal} /></div></div>
      </>}
      <div className="output"><h3>{item.type === 'user' ? 'User message' : generation ? 'Generation output' : 'Tool output'}</h3><Content value={item.output} /></div>
       {item.tools.length > 0 && <div className="tool-results"><h3>Tool results <span className="count-badge">{item.tools.length}</span></h3>{item.tools.map((tool: any, index: number) => <div className="tool-result" key={`${tool.id}-${index}`}><div className="tool-heading"><span><Icon name="tool" /><strong>{tool.name ?? 'Tool'}</strong></span><code>{tool.id ?? 'No call ID'}</code><span className={tool.results.length ? 'status' : 'subtle'}>{tool.inferred ? 'Inferred from timing' : tool.results.length ? 'Recorded' : 'Awaiting result'}</span></div>{tool.results.length ? tool.results.map((result: any) => <div key={result.id}><details className="nested"><summary>Tool input</summary><pre>{pretty(result.input)}</pre></details><Content value={result.output} /></div>) : <p className="note">No matching tool observation in this file yet.</p>}</div>)}</div>}
      <RawHistory filename={filename} id={item.id} />
    </div>}
  </article>;
}

function SessionDashboard({ session }: { session: SessionView }) {
  const latest = session.items[0]?.id;
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(latest ? [latest] : []));
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const previousLatest = useRef(latest);
  const scope = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (latest !== previousLatest.current) setExpanded(new Set(latest == null ? [] : [latest]));
    previousLatest.current = latest;
  }, [latest]);
  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add('(min-width: 1100px) and (prefers-reduced-motion: no-preference)', () => {
      ScrollTrigger.create({ trigger: '.timeline-layout', start: 'top 100px', end: 'bottom bottom', pin: '.timeline-aside', pinSpacing: false });
    });
    return () => media.revert();
  }, { scope });
  useEffect(() => { ScrollTrigger.refresh(); }, [expanded, filter, query, session]);
  const selectItem = (id: number) => {
    setFilter('all'); setQuery(''); setExpanded(previous => new Set([...previous, id]));
    requestAnimationFrame(() => document.getElementById(`observation-${id}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }));
  };
  const items = session.items.filter(item => (filter === 'all' || item.type === filter) && `${item.summary} ${item.provider} ${item.model} ${item.variant} ${item.mode} ${pretty(item.output)}`.toLowerCase().includes(query.toLowerCase()));
  return <div ref={scope}>
    <header className="hero session-hero"><div><a className="back-link" href="/dashboard"><Icon name="back" size={15} />All sessions</a><h1 className="max-w-6xl session-title" title={session.preview}>{session.preview}</h1><p className="session-filename">{session.filename}</p></div><div className="hero-side"><Signal /><span>{(session.bytes / 1024 / 1024).toFixed(2)} MB on disk</span><span>Updated {date(session.modified)}</span></div></header>
    <Metrics stats={session.stats} />
    {session.warnings.length > 0 && <details className="notice"><summary>{session.warnings.length} data {session.warnings.length === 1 ? 'notice' : 'notices'}</summary>{session.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
    <Analytics session={session} onSelect={selectItem} />
    <section className="chapter timeline-layout" aria-label="Observation timeline"><aside className="timeline-aside"><span className="eyebrow">Follow the conversation</span><h2>The session,<br />unfolded.</h2><p>Every prompt, decision<br />and tool result. In order.</p><div className="timeline-count"><strong>{format(session.items.length)}</strong><span>timeline observations</span></div><button className="button primary" disabled={!latest} onClick={() => latest && selectItem(latest)}>Jump to latest <Icon name="arrow" /></button><p className="note">Newest to oldest · local time<br />Tool results live with their generation.</p></aside>
      <div className="timeline-main"><div className="timeline-toolbar"><div className="tabs" role="group" aria-label="Filter observations">{[['all', 'All'], ['generation', 'Generations'], ['user', 'User'], ['tool', 'Other tools']].map(([value, label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="expand-controls"><button onClick={() => setExpanded(new Set(items.map(item => item.id)))}>Expand all</button><span>/</span><button onClick={() => setExpanded(new Set())}>Collapse all</button></div></div>
        <label className="search timeline-search"><Icon name="search" size={16} /><input placeholder="Find a message, model or tool…" aria-label="Search observations" value={query} onChange={event => setQuery(event.target.value)} /><span>{items.length} shown</span></label>
        <div className="observations">{items.map(item => <ObservationCard key={item.id} item={item} filename={session.filename} open={expanded.has(item.id)} onToggle={() => setExpanded(previous => { const next = new Set(previous); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; })} />)}</div>
        {!items.length && <div className="empty"><Icon name="search" size={28} /><h3>No observations found</h3><p>{session.items.length ? 'Try another search or filter.' : 'New observations will appear after the session is recorded and refreshed.'}</p>{session.items.length > 0 && <button className="button" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button>}</div>}
        <div className="timeline-end"><span className="dot" />{items.length ? 'Start of recorded history.' : 'Ready for the next observation.'}</div>
      </div>
    </section>
  </div>;
}

function Library({ sessions }: { sessions: LibraryEntry[] }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const stats = useMemo(() => {
    const sum = (values: (number | null)[]) => values.some(value => value != null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
    const usage = Object.fromEntries(Object.keys(usageLabels).map(key => [key, sum(sessions.map(session => session.stats.usage[key as keyof Usage]))])) as Usage;
    return { generations: sessions.reduce((sum, s) => sum + s.stats.generations, 0), users: sessions.reduce((sum, s) => sum + s.stats.users, 0), toolCalls: sessions.reduce((sum, s) => sum + s.stats.toolCalls, 0), usage,
      cost: sum(sessions.map(s => s.stats.cost)), reportedTotal: sum(sessions.map(s => s.stats.reportedTotal)), cacheHit: usage.input == null || usage.cache_read == null ? null : (usage.input + usage.cache_read + (usage.cache_write ?? 0)) ? usage.cache_read / (usage.input + usage.cache_read + (usage.cache_write ?? 0)) : 0,
      missingUsage: sessions.reduce((sum, s) => sum + s.stats.missingUsage, 0), missingCost: sessions.reduce((sum, s) => sum + s.stats.missingCost, 0), models: [...new Set(sessions.flatMap(s => s.stats.models))], durationMs: null, durationPartial: false };
  }, [sessions]);
  const filtered = sessions.filter(session => `${session.filename} ${session.preview} ${session.stats.models.join(' ')}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === 'cost' ? (b.stats.cost ?? -1) - (a.stats.cost ?? -1) : sort === 'tokens' ? (b.stats.usage.total ?? -1) - (a.stats.usage.total ?? -1) : b.modified.localeCompare(a.modified));
  return <>
    <header className="hero library-hero"><div><span className="eyebrow">Local intelligence, in focus</span><h1 className="max-w-6xl">A little clarity.<br />Every <Signal /> conversation.</h1><p>Your sessions, tokens and tool calls.<br />One place to see how the work happened.</p></div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><div className="orbit-core"><Signal /></div><span className="art-caption">FROM PROMPT TO PERSPECTIVE</span></div></header>
    <Metrics stats={stats} library={sessions.length} />
    {stats.models.length > 0 && <div className="model-strip"><span>In your workspace</span><div className="marquee"><div>{[0, 1].map(copy => <span className="marquee-set" aria-hidden={copy === 1 ? true : undefined} key={copy}>{stats.models.map(model => <span key={model}><span className="dot" />{model}</span>)}</span>)}</div></div></div>}
    <section className="chapter session-library"><div className="section-heading"><div><span className="eyebrow">Pick up the thread</span><h2>Your session library<span className="heading-count">{sessions.length}</span></h2></div><span className="subtle">JSONL files · stored locally</span></div>
      <div className="library-toolbar"><label className="search"><Icon name="search" /><input aria-label="Search sessions" placeholder="Search sessions, prompts or models…" value={query} onChange={event => setQuery(event.target.value)} /><kbd>/</kbd></label><select aria-label="Sort sessions" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Recently updated</option><option value="tokens">Most tokens</option><option value="cost">Highest cost</option></select></div>
      <div className="library-table-head"><span>Conversation</span><span>Generations</span><span>Tokens</span><span>Cost</span><span /></div>
      <div className="session-list">{filtered.map(session => <a className="session-link" href={`/dashboard?session=${encodeURIComponent(session.filename)}`} key={session.filename}><div className="session-description"><div className="session-meta"><Icon name="file" size={15} /><span>{date(session.modified)}</span><span className="model-name">{session.stats.models.join(' / ') || 'Awaiting generation'}</span></div><h3>{session.preview}</h3><div className="file-name">{session.filename}</div>{session.warnings.length > 0 && <span className="file-warning">{session.warnings.length} data notices</span>}</div><div className="session-number"><strong>{format(session.stats.generations)}</strong><small>{format(session.stats.toolCalls)} tools</small></div><div className="session-number"><strong>{compact(session.stats.usage.total)}</strong><small>{percent(session.stats.cacheHit)} cache hit</small></div><div className="session-number"><strong>{money(session.stats.cost)}</strong><small>USD</small></div><span className="session-arrow"><Icon name="arrow" /></span></a>)}</div>
      {!filtered.length && <div className="empty"><Icon name="file" size={32} /><h3>{sessions.length ? 'No matching sessions' : 'Your next conversation starts here.'}</h3><p>{sessions.length ? 'Try a different filename, prompt or model.' : 'Send observations to the receiver, then refresh to explore your sessions.'}</p>{query && <button className="button" onClick={() => setQuery('')}>Clear search</button>}</div>}
      <div className="library-bottom"><span>{filtered.length} of {sessions.length} sessions</span><span>Made for a closer look.</span></div>
    </section>
  </>;
}

function App() {
  const filename = new URLSearchParams(location.search).get('session');
  const [session, setSession] = useState<SessionView | null>(null);
  const [sessions, setSessions] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [auto, setAuto] = useState(false);
  const [showFloatingActions, setShowFloatingActions] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const scope = useRef<HTMLElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!filename) return;
    const update = () => setShowFloatingActions(
      (toolbar.current?.getBoundingClientRect().bottom ?? 0) < 0 &&
      (footer.current?.getBoundingClientRect().top ?? Infinity) > window.innerHeight
    );
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [filename]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    (filename ? getJSON<SessionView>(`/dashboard/api/session?session=${encodeURIComponent(filename)}`, controller.signal).then(setSession)
      : getJSON<{ sessions: LibraryEntry[] }>('/dashboard/api/sessions', controller.signal).then(data => setSessions(data.sessions)))
      .then(() => setUpdated(new Date())).catch(error => { if (error.name !== 'AbortError') setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filename, refresh]);
  useEffect(() => {
    if (!auto || loading) return;
    const timeout = setTimeout(() => { if (!document.hidden) setRefresh(value => value + 1); else setUpdated(value => value && new Date(value)); }, 10000);
    return () => clearTimeout(timeout);
  }, [auto, loading, updated]);
  useEffect(() => {
    document.title = filename ? `${session?.preview ?? filename} · Observatory` : 'Session library · Observatory';
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) { event.preventDefault(); document.querySelector<HTMLInputElement>('.search input')?.focus(); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [filename, session?.preview]);
  useGSAP(() => {
    if (!session && !sessions) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from('.hero h1', { opacity: 0.2, y: 12, duration: 0.8, ease: 'power3.out' });
      gsap.from('.chapter h2', { opacity: 0.3, scrollTrigger: { trigger: '.chapter', start: 'top 95%', end: 'top 65%', scrub: true } });
    });
    return () => media.revert();
  }, { scope, dependencies: [Boolean(session || sessions)] });
  return <main className="overflow-x-hidden w-full max-w-full" ref={scope}>
    <a className="skip-link" href="#content">Skip to content</a>
    <nav className="nav"><a className="brand" href="/dashboard"><span className="brand-mark"><i /><i /><i /></span>observatory<span className="brand-divider">/</span><span className="brand-sub">sessions</span></a><div className="nav-right"><span className="local-status"><span className="dot" />Local workspace</span><a className="nav-link" href="/dashboard">Library<Icon name="arrow" size={14} /></a></div></nav>
    <div className="workspace"><div className="workspace-toolbar" ref={toolbar}><span><span className="breadcrumb">Workspace</span><span className="slash">/</span>{filename ? 'Session detail' : 'Session library'}</span><div><label className="auto-refresh"><input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)} />Auto-refresh</label><button className={`refresh-button ${loading ? 'loading' : ''}`} disabled={loading} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={15} />{loading ? 'Loading' : 'Refresh'}</button></div></div>
      <div id="content">{error && <div className="error" role="alert"><h2>Couldn’t load the {filename ? 'session' : 'library'}.</h2><p>{error}</p><button className="button" onClick={() => setRefresh(value => value + 1)}>Try again</button>{filename && <a className="button" href="/dashboard">Back to library</a>}</div>}
        {!session && !sessions && loading && <div className="loading-state" role="status"><Signal /><h2>Bringing the details into focus.</h2><p>Reading your local session files…</p></div>}
         {session && <SessionDashboard key={session.filename} session={session} />}{sessions && !filename && <Library sessions={sessions} />}
      </div>
      <footer ref={footer}><a className="brand footer-brand" href="/dashboard">observatory<span className="dot" /></a><span>{updated ? `Last read ${updated.toLocaleTimeString()}` : 'Local session intelligence'} · All times local</span></footer>
    </div>
    {filename && session && <nav className={`floating-actions${showFloatingActions ? ' is-visible' : ''}`} aria-label="Session shortcuts" aria-hidden={!showFloatingActions} inert={!showFloatingActions}>
      <label className="auto-refresh"><input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)} />Auto-refresh</label>
      <a href="/dashboard"><Icon name="back" size={15} />All sessions</a>
      <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })}><Icon name="up" size={15} />Back to top</button>
    </nav>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
