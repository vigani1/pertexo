import { createWorkerApplication } from './app.js';
import { parseWorkerConfig } from './config/worker-config.js';

const KEEP_ALIVE_INTERVAL_MS = 2_147_483_647;

async function bootstrap(): Promise<void> {
  const config = parseWorkerConfig();
  await createWorkerApplication(config);

  // Queue connections will keep the process alive once consumers are added.
  // Until then, retain the standalone worker process so shutdown hooks can run.
  setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
}

void bootstrap().catch((error: unknown) => {
  console.error('Worker bootstrap failed', error);
  process.exitCode = 1;
});
