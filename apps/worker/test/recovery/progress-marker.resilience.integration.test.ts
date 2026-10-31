import { stat } from 'node:fs/promises';

import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import { delay } from '../support/recovery/facts.js';
import { startService, stopService } from '../support/recovery/services.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const MARKER = '/tmp/pertexo-worker-progress';
const SEVERAL_SCANS_MS = 20_000;
const STARTED_LIMIT_MS = 120_000;

const touchedAt = async (): Promise<number> => (await stat(MARKER)).mtimeMs;

/**
 * The health check ends a worker whose marker goes stale, so the marker has to
 * mean the right thing: it moves through a database outage, which is no reason to
 * restart anything, and stands still only when the worker itself has stopped.
 */
describeFaults('what the worker tells its health check', () => {
  let stack: Stack;
  let whileRunning: number;
  let duringOutage: number;
  let whileFrozen: number;

  const movedIn = async (millis: number): Promise<number> => {
    const before = await touchedAt();
    await delay(millis);
    return (await touchedAt()) - before;
  };

  beforeAll(async () => {
    stack = await startStack('progress-marker');
    await stack.worker.waitForLog(/worker\.started/u, STARTED_LIMIT_MS);
    whileRunning = await movedIn(SEVERAL_SCANS_MS);

    await stopService('postgres');
    duringOutage = await movedIn(SEVERAL_SCANS_MS);
    await startService('postgres');

    stack.worker.signal('SIGSTOP');
    // Let a write already under way land before the first reading.
    await delay(1_000);
    whileFrozen = await movedIn(SEVERAL_SCANS_MS);
    stack.worker.signal('SIGCONT');
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await startService('postgres');
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('moves while the worker runs', () => {
    expect(whileRunning).toBeGreaterThan(0);
  });

  it('keeps moving while Postgres is down', () => {
    expect(duringOutage).toBeGreaterThan(0);
  });

  it('stands still while the worker is stopped', () => {
    expect(whileFrozen).toBe(0);
  });
});
