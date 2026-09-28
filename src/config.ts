import { defaultDataDirectory } from './app.js';

export type Config = {
  host: string;
  port: number;
  dataDirectory: string;
  retentionDays: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');

  const portText = env.PORT ?? '45873';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  if (env.DATA_DIR === '') throw new Error('DATA_DIR must not be empty');

  const retentionText = env.RETENTION_DAYS ?? '30';
  const retentionDays = Number(retentionText);
  if (!/^[1-9]\d*$/.test(retentionText) || !Number.isSafeInteger(retentionDays)) {
    throw new Error('RETENTION_DAYS must be a positive integer');
  }

  return {
    host,
    port,
    dataDirectory: env.DATA_DIR ?? defaultDataDirectory(),
    retentionDays,
  };
}
