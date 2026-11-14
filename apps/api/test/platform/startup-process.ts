import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * How long a cold API process may take to read its settings and refuse. The
 * test that waits for it gets a little more, so a slow child fails with its
 * own timeout, not vitest's default 5 s (which used to cut it short while the
 * child was still inside this budget).
 */
const STARTUP_BUDGET_MS = 10_000;
export const STARTUP_TEST_TIMEOUT_MS = STARTUP_BUDGET_MS + 2_000;

/** Starts the real API from source with exactly this environment. */
export function startApiProcess(env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../../src/main.ts', import.meta.url)),
    ],
    { env, encoding: 'utf8', timeout: STARTUP_BUDGET_MS },
  );
}
