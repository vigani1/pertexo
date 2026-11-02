import { WORKERS } from './worker-databases.mjs';

/** Points this worker at its own database and Redis index, before a test file loads. */
const slot = ((Number(process.env.VITEST_POOL_ID ?? '1') - 1) % WORKERS) + 1;

for (const name of [
  'DATABASE_URL',
  'DATABASE_MAINTENANCE_URL',
  'DATABASE_MIGRATION_URL',
]) {
  const value = process.env[name];
  if (value === undefined) continue;
  const url = new URL(value);
  url.pathname = `${url.pathname}_w${slot}`;
  process.env[name] = url.href;
}

if (process.env.REDIS_URL !== undefined) {
  const url = new URL(process.env.REDIS_URL);
  url.pathname = `/${slot}`;
  process.env.REDIS_URL = url.href;
}
