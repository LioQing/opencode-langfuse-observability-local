# OpenCode Langfuse Observability Local

> [!WARNING]
>
> This is a vibe-coded personal project.

https://github.com/user-attachments/assets/29e77b8f-5839-4779-9075-cd0da966d0dd

A local receiver and session dashboard for Langfuse data sent by the OpenCode plugin `langfuse/opencode-observability-plugin`. It saves each session's observation history to disk and makes it explorable in the browser. It is not a full Langfuse server.

Requires Node.js 20 or newer.

```sh
npm install
npm run dev
```

## Start automatically with OpenCode V2

Add the GitHub repository to the `plugins` array in `~/.config/opencode/opencode.jsonc` (or `.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:LioQing/opencode-langfuse-observability-local#master",
      "options": { "port": 45873, "retentionDays": 30 }
    }
  ]
}
```

OpenCode installs the Git package from the repository's `master` branch. The receiver and dashboard build outputs are committed with the source. npm prepares Git dependencies with a `build` script even when they have no `prepare` script, so this package uses `npm run bundle` for source builds instead; OpenCode's bundled runtime cannot run npm's nested Git preparation on Windows. Run `npm run bundle` and commit the updated `dist/` files when changing the receiver or dashboard. Node.js 20+, npm and Git must be available to the OpenCode service. Push changes to GitHub before installing or updating the Git plugin; uncommitted local changes are not included. To use a local checkout instead, run `npm install` and `npm run bundle`, then set `package` to its absolute `plugins/receiver` directory (use forward slashes on Windows). Preserve any existing plugins when adding this entry. Set `options.port` to any available port from 1 to 65535 (or omit it to use `PORT` from the OpenCode service, falling back to `45873`). Set the Langfuse plugin's `baseUrl` to the **same port**. This is an **OpenCode V2** plugin: its `setup` launches the built receiver with Node when OpenCode loads it, and its cleanup stops that child when the plugin unloads. It shares a single receiver across locations in the same OpenCode process. If a receiver is already serving `/dashboard` on the configured address, it leaves that process alone (and does not stop it on unload). An unrelated process on the port causes startup to fail rather than replacing that process. After changing the bundle, update the Git plugin with `opencode plugin update` and restart the OpenCode service to use the new server code.

`options.retentionDays` is an optional positive integer (default `30`); it overrides `RETENTION_DAYS` for plugin-launched receivers. On startup and once a day, the receiver deletes session JSONL files whose **last modification** was at least that many days ago. It leaves other files alone. Existing receivers already running on the port keep their own retention settings.

The spawned receiver inherits `HOST` and `DATA_DIR` from the OpenCode service; `options.port` overrides an inherited `PORT`. Its default storage is the built-release home directory, not the repository's `./data`. Run `opencode service status` to inspect the service, and open **http://127.0.0.1:45873/dashboard** to check the receiver. You still need the separate Langfuse observability plugin configured to send traces to this address.

Configure the plugin's Langfuse connection with arbitrary keys (this receiver does not authenticate them):

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "http://127.0.0.1:45873"
}
```

## Dashboard

Open **http://127.0.0.1:45873/dashboard** to browse all `.jsonl` files in the configured data directory. Select a session to open `/dashboard?session=<filename>.jsonl`.

- Search sessions by filename, prompt or model, and sort by update time, tokens or cost.
- Explore aggregate usage, cost and cache-hit metrics. Select a chart bar to jump to a generation.
- The timeline sorts by exact nanosecond start timestamps. Generation deltas are reconstructed in file order before sorting. Agent wrapper spans are excluded to avoid duplicating the conversation; unmatched tool observations remain visible.
- User and generation observations are collapsed except the latest. Expand a generation for provider/model/variant/mode, input-history message counts, output tool-call count, token breakdown, cache hit, cost, duration, output and tool results matched by call ID. Raw input history loads only when expanded.
- In this plugin's format, `input` is uncached input and the reported `total` excludes cache reads/writes. The dashboard's full total adds `cache_read` and `cache_write`; each generation also shows the original reported total. Cache hit is `cache_read / (input + cache_read + cache_write)`. Percentages use the full total. Unknown values are shown as a dash; recorded zero costs remain zero.
- Refresh manually or enable 10-second auto-refresh; the selection persists in browser local storage across visits. Invalid/incomplete JSONL lines produce notices while valid observations remain available. Times are displayed in the browser's local timezone.

The React UI, GSAP animations and Geist fonts are bundled and served by the same Fastify application, with no runtime CDN dependencies. Reduced-motion preferences are respected. `npm run dev` builds frontend assets before starting the server; after editing frontend files, run `npm run build:ui` and refresh. `npm run bundle` builds both the server and UI.

The dashboard uses the same `DATA_DIR` as the receiver. To explore the repository's example files with a built release, set `DATA_DIR` to `./data` (built releases otherwise use the home directory described below).

Run `npm run test:ui` for browser interaction checks. It uses Microsoft Edge on Windows and Playwright Chromium elsewhere (`npx playwright install chromium` if needed). Set `BROWSER_CHANNEL` to choose another installed browser, such as `chrome`.

The receiver uses plain HTTP and binds to `127.0.0.1` by default. It does not use or generate TLS certificates. Certificates created by older versions can be removed manually if no longer needed.

Send a JSON trace request:

```sh
curl -X POST http://127.0.0.1:45873/api/public/otel/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[]}'
```

For `POST /api/public/otel/v1/traces` with a valid JSON body, event, generation, agent, and tool observations are saved as separate JSONL entries in request order without being printed to stdout. Unknown observation types are printed to stdout with `format: "unknown_observation"` and the original span. Each saved entry maps the span's attribute `key` to its typed value (for example, `stringValue` becomes a string and `boolValue` becomes a boolean). The `langfuse.observation.metadata`, `input`, `output`, `usage_details`, and `cost_details` string values are parsed as JSON when valid; otherwise they remain strings.

Observations with a valid `session.id` are saved under `data/` relative to the working directory when running the TypeScript source with `npm run dev`. In a built release (`npm run bundle` followed by `npm start`), they are saved under `~/.local/share/opencode-langfuse-observability-local/data/` instead. Event, agent, and tool spans without a session ID use an adjacent generation or tool's session ID when available. Files are named `yyyy-mm-dd-HH-MM-ss-<session.id>.jsonl`. Every new JSONL line stores its own span's `startTimeUnixNano` and `endTimeUnixNano` as exact nanosecond strings when present. Event, agent, and tool lines contain all their decoded attributes, even when values are unchanged. Generation lines after the first use the comparison approach: they include observation type, `langfuse.observation.input.messages` and `langfuse.observation.output` when present, plus per-generation `usage_details` and `cost_details`. Other generation fields are included only when their values differ from the latest effective generation values: model name, input system and tools, individual metadata fields, plugin and OpenCode versions, user ID, environment, and `is_app_root`. Unlisted fields are only present in the first line. The filename keeps its original local-time timestamp, including after a restart. Existing `.json` files from the older format are left untouched; the next observation starts a new `.jsonl` history. Existing JSONL lines with older timestamps are left unchanged.

Spans without an observation type produce no output. Apart from dashboard GET/HEAD requests under `/dashboard`, any other path, method, or invalid JSON body is logged as a JSON line with `format: "unknown"`, `method`, `path`, `body` (UTF-8 text), and `bodyBase64` (the exact bytes, useful for binary payloads). Valid trace requests return `204 No Content`. The receiver does not require a particular Content-Type header; it checks whether the trace body is valid JSON.

Configuration (environment variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address; changing this can expose collected prompts and outputs to the network. |
| `PORT` | `45873` | HTTP listen port (1–65535). The OpenCode receiver plugin's `options.port` takes precedence; update the Langfuse plugin's `baseUrl` to match. |
| `DATA_DIR` | `./data` in dev; `~/.local/share/opencode-langfuse-observability-local/data` in built releases | Storage directory for JSONL files. |
| `RETENTION_DAYS` | `30` | Positive integer number of days since a session JSONL file was last modified before automatic deletion. The receiver plugin's `options.retentionDays` takes precedence. |

For a production-style run, use `npm run bundle` followed by `npm start`. Run the tests with `npm test`. This receiver does not check Langfuse keys; keep the default loopback bind unless you provide your own network access controls.
