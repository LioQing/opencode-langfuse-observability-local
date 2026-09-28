import { Plugin } from '@opencode/plugin';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../../dist/server.js', import.meta.url));
const state = globalThis[Symbol.for('opencode-langfuse-observability-local.receiver')] ??= {
  refs: 0,
  starting: undefined,
  child: undefined,
  port: undefined,
  retentionDays: undefined,
};

function configuredPort(options) {
  const selected = options?.port;
  if (selected !== undefined && (typeof selected !== 'number' || !Number.isInteger(selected))) {
    throw new Error('Receiver plugin option port must be an integer between 1 and 65535');
  }
  const port = selected ?? process.env.PORT ?? '45873';
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Receiver port must be an integer between 1 and 65535');
  }
  return String(port);
}

function configuredRetentionDays(options) {
  const selected = options?.retentionDays;
  if (selected !== undefined && (typeof selected !== 'number' || !Number.isSafeInteger(selected) || selected < 1)) {
    throw new Error('Receiver plugin option retentionDays must be a positive integer');
  }
  const days = selected ?? process.env.RETENTION_DAYS ?? '30';
  if (!/^[1-9]\d*$/.test(String(days)) || !Number.isSafeInteger(Number(days))) {
    throw new Error('Receiver retentionDays must be a positive integer');
  }
  return String(days);
}

function endpoint(port) {
  const host = process.env.HOST ?? '127.0.0.1';
  const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${probeHost.includes(':') ? `[${probeHost}]` : probeHost}:${port}/dashboard`;
}

async function receiverIsRunning(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    return response.ok && (await response.text()).includes('<title>Session observatory</title>');
  } catch {
    return false;
  }
}

async function start(port, retentionDays) {
  const url = endpoint(port);
  if (await receiverIsRunning(url)) return;

  const child = spawn('node', [server], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, PORT: port, RETENTION_DAYS: retentionDays },
  });
  state.child = child;
  let failure;
  child.once('error', (error) => { failure = error; });
  child.once('exit', (code) => {
    if (state.child === child) state.child = undefined;
    failure ??= new Error(`Receiver exited with code ${code}`);
  });

  for (let attempt = 0; attempt < 30; attempt++) {
    if (failure) throw failure;
    if (await receiverIsRunning(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`Receiver did not become ready at ${url}; check for a port conflict or build errors`);
}

export default Plugin.define({
  id: 'opencode-langfuse-observability-local.receiver',
  async setup(ctx) {
    const port = configuredPort(ctx.options);
    const retentionDays = configuredRetentionDays(ctx.options);
    if (state.refs || state.starting) {
      if (state.port !== port) throw new Error(`Receiver is already configured on port ${state.port}`);
      if (state.retentionDays !== retentionDays) throw new Error(`Receiver is already configured with retentionDays ${state.retentionDays}`);
    }
    state.port = port;
    state.retentionDays = retentionDays;
    state.starting ??= start(port, retentionDays).catch((error) => {
      state.child?.kill();
      state.child = undefined;
      state.port = undefined;
      state.retentionDays = undefined;
      throw error;
    }).finally(() => { state.starting = undefined; });
    await state.starting;
    state.refs++;
    return () => {
      if (--state.refs === 0) {
        state.child?.kill();
        state.child = undefined;
        state.port = undefined;
        state.retentionDays = undefined;
      }
    };
  },
});
