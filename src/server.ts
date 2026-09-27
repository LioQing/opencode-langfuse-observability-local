import { createApp } from './app.js';
import { loadConfig } from './config.js';

try {
  const config = loadConfig();
  const app = createApp(undefined, config.dataDirectory);
  await app.listen({ host: config.host, port: config.port });
  console.error(`Listening on http://${config.host}:${config.port}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
