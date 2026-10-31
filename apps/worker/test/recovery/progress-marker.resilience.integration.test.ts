import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import { delay } from '../support/recovery/facts.js';
import {
  pauseService,
  startService,
  stopService,
  unpauseService,
} from '../support/recovery/services.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const markerPreload = fileURLToPath(
  new URL(
    '../support/recovery/stand-ins/progress-marker-preload.mjs',
    import.meta.url,
  ),
);
const SEVERAL_SCANS_MS = 20_000;
// Past the 5 s between scans, so the scan under way when Postgres hung has met it.
const SCAN_MEETS_HANG_MS = 7_000;

/**
 * The health check ends a worker whose marker goes stale, so the marker has to
 * mean the right thing: it moves through a database outage, which is no reason to
 * restart anything, and stands still only when the worker itself has stopped.
 */
describeFaults('what the worker tells its health check', () => {
  let stack: Stack;
  let directory: string;
  let marker: string;
  let whileRunning: number;
  let duringOutage: number;
  let whileFrozen: number;
  let whileScanHung: number;
  let writtenBy: string;

  const touchedAt = async (): Promise<number> => (await stat(marker)).mtimeMs;

  const movedIn = async (millis: number): Promise<number> => {
    const before = await touchedAt();
    await delay(millis);
    return (await touchedAt()) - before;
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pertexo-progress-marker-'));
    marker = join(directory, 'progress');
    stack = await startStack('progress-marker', {
      workerEnvironment: {
        NODE_OPTIONS: `--import=${markerPreload}`,
        PROGRESS_MARKER_STAND_IN: marker,
      },
    });
    whileRunning = await movedIn(SEVERAL_SCANS_MS);
    writtenBy = await readFile(marker, 'utf8');

    await stopService('postgres');
    duringOutage = await movedIn(SEVERAL_SCANS_MS);
    await startService('postgres');

    await pauseService('postgres');
    await delay(SCAN_MEETS_HANG_MS);
    whileScanHung = await movedIn(SEVERAL_SCANS_MS);
    await unpauseService('postgres');

    stack.worker.signal('SIGSTOP');
    // Let a write already under way land before the first reading.
    await delay(1_000);
    whileFrozen = await movedIn(SEVERAL_SCANS_MS);
    stack.worker.signal('SIGCONT');
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await unpauseService('postgres').catch(() => undefined);
    await startService('postgres');
    await stack.close();
    await rm(directory, { recursive: true, force: true });
  }, SCENARIO_LIMIT_MS);

  it('moves while the worker runs, and names it', () => {
    expect(whileRunning).toBeGreaterThan(0);
    expect(writtenBy).toBe(String(stack.worker.pid));
  });

  it('keeps moving while Postgres is down', () => {
    expect(duringOutage).toBeGreaterThan(0);
  });

  // The worker is alive and turning here. Only a scan that has really stopped
  // leaves the marker alone, so anything that moves it apart from the scan shows.
  it('stands still while a scan can not finish', () => {
    expect(whileScanHung).toBe(0);
  });

  it('stands still while the worker is stopped', () => {
    expect(whileFrozen).toBe(0);
  });
});
