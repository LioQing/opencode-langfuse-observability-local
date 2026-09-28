import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { fetchModelPricing } from './model-pricing.js';
import type { PricingStore } from './model-pricing.js';

try {
  const config = loadConfig();
  const pricing: PricingStore = { catalog: null };
  const app = createApp(undefined, config.dataDirectory, undefined, config.retentionDays, pricing);
  pricing.ready = fetchModelPricing().then(catalog => { pricing.catalog = catalog; })
    .catch(error => console.error('Could not load models.dev pricing:', error));
  await app.listen({ host: config.host, port: config.port });
  // A V2 plugin can launch the receiver with an IPC channel. If OpenCode exits
  // unexpectedly, close the listener rather than leaving an orphan on port 3000.
  if (process.connected) process.on('disconnect', () => void app.close());
  console.error(`Listening on http://${config.host}:${config.port}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
