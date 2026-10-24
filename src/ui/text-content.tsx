import React, { useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatContent } from './content-format.js';

type View = 'formatted' | 'markdown' | 'raw';
const serialize = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'Not recorded';

function JSONValue({ value, depth = 0, comma = false }: { value: unknown; depth?: number; comma?: boolean }) {
  const container = value !== null && typeof value === 'object';
  const count = container ? Object.keys(value).length : 0;
  const [open, setOpen] = useState(depth < 2 && count <= (depth === 0 ? 50 : 8));
  const [limit, setLimit] = useState(100);
  if (!container) {
    if (typeof value === 'string' && (value.includes('\n') || value.includes('\r') || value.length > 160)) return <pre className="json-string-block"><code>{value}</code></pre>;
    return <><span className={`json-${value === null ? 'null' : typeof value}`}>{JSON.stringify(value)}</span>{comma && <span className="json-punctuation">,</span>}</>;
  }
  const array = Array.isArray(value);
  const start = array ? '[' : '{';
  const end = array ? ']' : '}';
  if (!count) return <span className="json-punctuation">{start}{end}{comma && ','}</span>;
  // Deep content stays available without building an unbounded component tree.
  if (depth >= 20) return <pre><code>{serialize(value)}</code></pre>;
  return <details className="json-node" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className="json-punctuation">{start}{!open && ` … ${end}${comma ? ',' : ''}`}</span><span className="json-count">{count} {array ? 'items' : 'keys'}</span></summary>
    {open && <><div className="json-entries">{Object.entries(value).slice(0, limit).map(([key, child], index) => <div className="json-entry" key={key}>
      {!array && <span className="json-key">{JSON.stringify(key)}<span className="json-punctuation">: </span></span>}
      <JSONValue value={child} depth={depth + 1} comma={index < count - 1} />
    </div>)}{count > limit && <button type="button" className="json-more" onClick={() => setLimit(limit + 100)}>Show next {Math.min(100, count - limit)} of {count - limit} remaining</button>}</div><span className="json-punctuation">{end}{comma && ','}</span></>}
  </details>;
}

export function TextContent({ value, defaultView = 'formatted' }: { value: unknown; defaultView?: View }) {
  const [view, setView] = useState<View>(defaultView);
  const text = useMemo(() => serialize(value), [value]);
  const blocks = useMemo(() => formatContent(text), [text]);
  return <div className="text-content">
    <div className="text-view-toggle" role="group" aria-label="Text display mode">
      {(['formatted', 'markdown', 'raw'] as const).map(mode => <button type="button" key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>{mode === 'formatted' ? 'Formatted' : mode === 'markdown' ? 'Markdown' : 'Raw'}</button>)}
    </div>
    {view === 'raw' ? <pre><code>{text}</code></pre> : view === 'formatted' ? <div className="formatted-content">{blocks.map((block, index) => block.type === 'json'
      ? <div className="json-view" key={index}><JSONValue value={block.value} /></div>
      : <pre className="formatted-text" key={index}><code>{block.text}</code></pre>)}</div>
      : <div className="prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        img: ({ alt }) => <span className="subtle">[Image: {alt || 'attachment'}]</span>,
      }}>{text}</Markdown></div>}
  </div>;
}
