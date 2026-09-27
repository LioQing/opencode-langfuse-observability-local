import { defaultDataDirectory } from './app.js';

export type Config = {
  host: string;
  port: number;
  dataDirectory: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');

  const portText = env.PORT ?? '3000';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  if (env.DATA_DIR === '') throw new Error('DATA_DIR must not be empty');

  return {
    host,
    port,
    dataDirectory: env.DATA_DIR ?? defaultDataDirectory(),
  };
}
