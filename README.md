# OpenCode Langfuse Observability Local

> [!WARNING]
> This is a vibe-coded personal project.

https://github.com/user-attachments/assets/29e77b8f-5839-4779-9075-cd0da966d0dd

A local receiver and dashboard for data sent by the OpenCode plugin `langfuse/opencode-observability-plugin`. It saves observations to per-session JSONL files and lets you explore them in a browser. It is not a full Langfuse server.

Requires Node.js 20 or newer.

## Start manually

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:45873/dashboard>.

## Start automatically with OpenCode V2

Add the receiver to OpenCode's `plugins` array in `~/.config/opencode/opencode.jsonc` (or `opencode.json`). Keep any plugins already in the array.

### Install from GitHub

Add this object to `plugins`:

```json
{
  "package": "github:LioQing/opencode-langfuse-observability-local#master",
  "options": {
    "port": 45873,
    "retentionDays": 30
  }
}
```

For example, the complete config can look like this:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:LioQing/opencode-langfuse-observability-local#master",
      "options": {
        "port": 45873,
        "retentionDays": 30
      }
    }
  ]
}
```

GitHub installs require Git, npm, and Node.js 20 or newer to be available to the OpenCode service. Push changes to GitHub before running `opencode plugin update` to install them.

**Windows note:** OpenCode V2 2.0.18 may fail to install this Git package with `git dep preparation failed`. If that happens, use the local-clone instructions below.

### Install from a local clone

Clone the repository and build it with Node.js 20 or newer:

```sh
git clone https://github.com/LioQing/opencode-langfuse-observability-local.git
cd opencode-langfuse-observability-local
npm ci
npm run bundle
```

Add this object to the `plugins` array in your OpenCode config. Replace the example path with the **absolute path** to the clone's `plugins/receiver` directory. Use forward slashes on Windows:

```json
{
  "package": "C:/path/to/opencode-langfuse-observability-local/plugins/receiver",
  "options": {
    "port": 45873,
    "retentionDays": 30
  }
}
```

After pulling updates, run `npm ci` and `npm run bundle` in the clone, then restart the OpenCode service:

```sh
opencode service restart
```

`opencode plugin update` does not update local paths.

### Receiver and Langfuse settings

- `options.port` can be any available port from 1 to 65535. Omit it to use `PORT` from the OpenCode service, or `45873` if `PORT` is not set.
- Set the Langfuse observability plugin's `baseUrl` to the same port.
- `options.retentionDays` is an optional positive integer. It defaults to `30` and overrides `RETENTION_DAYS` for plugin-launched receivers.
- The receiver inherits `HOST` and `DATA_DIR` from the OpenCode service. `options.port` overrides its inherited `PORT`.
- The receiver's default storage is the built-release home directory, not the repository's `./data` directory.

The OpenCode V2 plugin starts the built receiver when OpenCode loads and stops it when the plugin unloads. A single receiver is shared by plugin locations in the same OpenCode process. If the configured address already serves this receiver's `/dashboard`, the plugin leaves it running and does not stop it on unload. If an unrelated process occupies the port, startup fails rather than replacing that process.

The receiver removes session JSONL files whose last-modified time is at least `retentionDays` old. Cleanup runs at startup and once a day. It does not delete other files. A receiver already running on the port keeps its existing retention settings.

Check the OpenCode service with `opencode service status`. Open <http://127.0.0.1:45873/dashboard> to check the receiver. You also need the separate Langfuse observability plugin configured to send traces to it.

Put the Langfuse connection settings in `~/.config/opencode/opencode-langfuse.json`. The receiver does not authenticate the keys, so the values can be arbitrary:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "http://127.0.0.1:45873"
}
```

## Dashboard

Open <http://127.0.0.1:45873/dashboard> to browse `.jsonl` files in the configured data directory. Select a session to open `/dashboard?session=<filename>.jsonl`.

The dashboard can:

- Search sessions by filename, prompt, or model; sort by update time, tokens, or cost.
- Show aggregate usage, cost, and cache-hit metrics. Select a chart bar to jump to a generation.
- Show a timeline sorted by exact nanosecond start times. Generation deltas are reconstructed in file order before sorting. Agent wrapper spans are hidden to avoid duplicating the conversation; unmatched tool observations remain visible.
- Collapse user and generation observations except the latest. Expand a generation to see provider, model, variant, mode, input-history message count, output tool-call count, token breakdown, cache hit, cost, duration, output, and tool results matched by call ID. Raw input history loads only when expanded.
- Refresh manually or automatically every 10 seconds. The selected session persists in browser local storage. Invalid or incomplete JSONL lines produce notices, while valid observations remain available. Times use the browser's local timezone.

### Usage and cost calculations

In this plugin's format, `input` is uncached input, and the reported `total` excludes cache reads and writes. The dashboard adds `cache_read` and `cache_write` to calculate the full total, while also showing each generation's reported total.

- Cache hit = `cache_read / (input + cache_read + cache_write)`.
- Usage percentages use the full total.
- Unknown values appear as a dash. A recorded cost of zero remains zero.

At startup, the receiver fetches provider and model prices from <https://models.dev/api.json>. It sends no prompts or session data. Session and library cost cards show an estimated total, with input, output, cached-input, and cached-output costs, when it differs from the displayed recorded cost. Reasoning cost is included in output cost.

Estimates require complete generation usage and matching provider/model prices. Otherwise, the recorded-cost line stays unchanged. If the price catalog cannot be fetched within 10 seconds, the receiver runs without estimates.

The React UI, GSAP animations, and Geist fonts are bundled and served by the Fastify application. There are no runtime CDN dependencies, and the UI respects reduced-motion preferences.

After editing UI files, run `npm run build:ui` and refresh the browser. `npm run dev` builds the UI before starting the server. `npm run bundle` builds the server and UI.

Run browser interaction checks with:

```sh
npm run test:ui
```

The script uses Microsoft Edge on Windows and Playwright Chromium elsewhere. Install Chromium if needed with `npx playwright install chromium`. Set `BROWSER_CHANNEL` to use another installed browser, such as `chrome`.

The dashboard reads from the same `DATA_DIR` as the receiver. To view the repository's example files with a built release, set `DATA_DIR=./data`. Built releases otherwise use the home-directory location described below.

## Receiver behavior

The receiver uses plain HTTP and binds to `127.0.0.1` by default. It does not use or generate TLS certificates. Certificates created by older versions can be removed manually if they are no longer needed.

Send a JSON trace request to test the endpoint:

```sh
curl -X POST http://127.0.0.1:45873/api/public/otel/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[]}'
```

Valid `POST /api/public/otel/v1/traces` requests return `204 No Content`. The receiver checks that the body is valid JSON; it does not require a particular `Content-Type` header.

For valid trace requests:

- Event, generation, agent, and tool observations are saved as separate JSONL entries in request order. They are not printed to stdout.
- Unknown observation types are printed to stdout with `format: "unknown_observation"` and the original span.
- Span attributes are converted from their typed values. For example, `stringValue` becomes a string and `boolValue` becomes a boolean.
- String values for `langfuse.observation.metadata`, `input`, `output`, `usage_details`, and `cost_details` are parsed as JSON when valid; otherwise, they remain strings.
- Spans without an observation type produce no output.

Observations with a valid `session.id` are saved as JSONL files. Event, agent, and tool spans without a session ID use an adjacent generation or tool's session ID when available. Filenames use the format `yyyy-mm-dd-HH-MM-ss-<session.id>.jsonl`.

Storage locations depend on how the receiver runs:

- `npm run dev`: `./data`, relative to the working directory.
- Built release (`npm run bundle` followed by `npm start`): `~/.local/share/opencode-langfuse-observability-local/data/`.

Each new JSONL line stores its span's `startTimeUnixNano` and `endTimeUnixNano` as exact nanosecond strings when present. Event, agent, and tool lines include all decoded attributes, even if their values have not changed.

Generation lines after the first use deltas. Each includes observation type, `langfuse.observation.input.messages` and `langfuse.observation.output` when present, and per-generation `usage_details` and `cost_details`. Other generation fields are included only when they differ from the latest effective values:

- Model name
- Input system and tools
- Individual metadata fields
- Plugin and OpenCode versions
- User ID and environment
- `is_app_root`

Fields not listed above appear only in the first generation line. Filenames keep their original local-time timestamp after a restart. Existing `.json` files from the older format are left untouched; the next observation starts a new `.jsonl` history. Existing JSONL lines with older timestamps are not changed.

Dashboard `GET` and `HEAD` requests under `/dashboard` bypass raw-request logging. Other paths, methods, and invalid JSON bodies are logged as a JSON line with `format: "unknown"`, `method`, `path`, `body` (UTF-8 text), and `bodyBase64` (the exact bytes, useful for binary payloads).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address to bind. Changing this can expose collected prompts and outputs to the network. |
| `PORT` | `45873` | HTTP port (1–65535). The OpenCode receiver plugin's `options.port` takes precedence. Set the Langfuse plugin's `baseUrl` to the same port. |
| `DATA_DIR` | `./data` in development; `~/.local/share/opencode-langfuse-observability-local/data` in built releases | Directory for JSONL files. |
| `RETENTION_DAYS` | `30` | Positive integer: delete session JSONL files after this many days since their last modification. The receiver plugin's `options.retentionDays` takes precedence. |

For a production-style run, bundle and start the receiver:

```sh
npm run bundle
npm start
```

Run tests with:

```sh
npm test
```

The receiver does not check Langfuse keys. Keep the default loopback bind unless you provide your own network access controls.
