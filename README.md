# OpenCode Langfuse Observability Local

> [!WARNING]
>
> This is a vibe-coded personal project.

A local receiver and session dashboard for Langfuse data sent by the OpenCode plugin `langfuse/opencode-observability-plugin`. It saves each session's observation history to disk and makes it explorable in the browser. It is not a full Langfuse server.

Requires Node.js 20 or newer.

```sh
npm install
npm run dev
```

Configure the plugin's Langfuse connection with arbitrary keys (this receiver does not authenticate them):

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "http://127.0.0.1:3000"
}
```

## Dashboard

Open **http://127.0.0.1:3000/dashboard** to browse all `.jsonl` files in the configured data directory. Select a session to open `/dashboard?session=<filename>.jsonl`.

- Search sessions by filename, prompt or model, and sort by update time, tokens or cost.
- Explore aggregate usage, cost and cache-hit metrics. Select a chart bar to jump to a generation.
- The timeline sorts by exact nanosecond start timestamps. Generation deltas are reconstructed in file order before sorting. Agent wrapper spans are excluded to avoid duplicating the conversation; unmatched tool observations remain visible.
- User and generation observations are collapsed except the latest. Expand a generation for provider/model/variant/mode, input-history message counts, output tool-call count, token breakdown, cache hit, cost, duration, output and tool results matched by call ID. Raw input history loads only when expanded.
- In this plugin's format, `input` is uncached input and the reported `total` excludes cache reads/writes. The dashboard's full total adds `cache_read` and `cache_write`; each generation also shows the original reported total. Cache hit is `cache_read / (input + cache_read + cache_write)`. Percentages use the full total. Unknown values are shown as a dash; recorded zero costs remain zero.
- Refresh manually or enable 10-second auto-refresh. Invalid/incomplete JSONL lines produce notices while valid observations remain available. Times are displayed in the browser's local timezone.

The React UI, GSAP animations and Geist fonts are bundled and served by the same Fastify application, with no runtime CDN dependencies. Reduced-motion preferences are respected. `npm run dev` builds frontend assets before starting the server; after editing frontend files, run `npm run build:ui` and refresh. `npm run build` builds both the server and UI.

The dashboard uses the same `DATA_DIR` as the receiver. To explore the repository's example files with a built release, set `DATA_DIR` to `./data` (built releases otherwise use the home directory described below).

Run `npm run test:ui` for browser interaction checks. It uses Microsoft Edge on Windows and Playwright Chromium elsewhere (`npx playwright install chromium` if needed). Set `BROWSER_CHANNEL` to choose another installed browser, such as `chrome`.

The receiver uses plain HTTP and binds to `127.0.0.1` by default. It does not use or generate TLS certificates. Certificates created by older versions can be removed manually if no longer needed.

Send a JSON trace request:

```sh
curl -X POST http://127.0.0.1:3000/api/public/otel/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[]}'
```

For `POST /api/public/otel/v1/traces` with a valid JSON body, event, generation, agent, and tool observations are saved as separate JSONL entries in request order without being printed to stdout. Unknown observation types are printed to stdout with `format: "unknown_observation"` and the original span. Each saved entry maps the span's attribute `key` to its typed value (for example, `stringValue` becomes a string and `boolValue` becomes a boolean). The `langfuse.observation.metadata`, `input`, `output`, `usage_details`, and `cost_details` string values are parsed as JSON when valid; otherwise they remain strings.

Observations with a valid `session.id` are saved under `data/` relative to the working directory when running the TypeScript source with `npm run dev`. In a built release (`npm run build` followed by `npm start`), they are saved under `~/.local/share/opencode-langfuse-observability-local/data/` instead. Event, agent, and tool spans without a session ID use an adjacent generation or tool's session ID when available. Files are named `yyyy-mm-dd-HH-MM-ss-<session.id>.jsonl`. Every new JSONL line stores its own span's `startTimeUnixNano` and `endTimeUnixNano` as exact nanosecond strings when present. Event, agent, and tool lines contain all their decoded attributes, even when values are unchanged. Generation lines after the first use the comparison approach: they include observation type, `langfuse.observation.input.messages` and `langfuse.observation.output` when present, plus per-generation `usage_details` and `cost_details`. Other generation fields are included only when their values differ from the latest effective generation values: model name, input system and tools, individual metadata fields, plugin and OpenCode versions, user ID, environment, and `is_app_root`. Unlisted fields are only present in the first line. The filename keeps its original local-time timestamp, including after a restart. Existing `.json` files from the older format are left untouched; the next observation starts a new `.jsonl` history. Existing JSONL lines with older timestamps are left unchanged.

Spans without an observation type produce no output. Apart from dashboard GET/HEAD requests under `/dashboard`, any other path, method, or invalid JSON body is logged as a JSON line with `format: "unknown"`, `method`, `path`, `body` (UTF-8 text), and `bodyBase64` (the exact bytes, useful for binary payloads). Valid trace requests return `204 No Content`. The receiver does not require a particular Content-Type header; it checks whether the trace body is valid JSON.

Configuration (environment variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address; changing this can expose collected prompts and outputs to the network. |
| `PORT` | `3000` | HTTP listen port (1–65535). Update the plugin's `baseUrl` if changed. |
| `DATA_DIR` | `./data` in dev; `~/.local/share/opencode-langfuse-observability-local/data` in built releases | Storage directory for JSONL files. |

For a production-style run, use `npm run build` followed by `npm start`. Run the tests with `npm test`. This receiver does not check Langfuse keys; keep the default loopback bind unless you provide your own network access controls.
