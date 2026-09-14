import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const fixturePath = fileURLToPath(
  new URL('./worker-process-lifecycle.fixture.mjs', import.meta.url),
);
const PROCESS_STARTUP_TIMEOUT_MILLIS = 5_000;
const PROCESS_SHUTDOWN_TIMEOUT_MILLIS = 5_000;
const PROCESS_TEST_TIMEOUT_MILLIS =
  PROCESS_STARTUP_TIMEOUT_MILLIS + PROCESS_SHUTDOWN_TIMEOUT_MILLIS + 1_000;
const FORCE_KILL_TIMEOUT_MILLIS = 1_000;
const MAX_CHILD_OUTPUT_CHARACTERS = 64 * 1_024;
const children = new Set<ChildProcess>();

type ProcessFixture = Readonly<{
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
}>;

function startFixture(mode: 'active' | 'bootstrap-failure' | 'disabled') {
  const child = spawn(process.execPath, [fixturePath, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  const append = (chunk: string): void => {
    const remaining = MAX_CHILD_OUTPUT_CHARACTERS - output.length;
    if (remaining > 0) output += chunk.slice(0, remaining);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, exit, output: () => output } satisfies ProcessFixture;
}

async function waitForOutput(
  output: () => string,
  expected: string,
): Promise<void> {
  await expect
    .poll(output, { timeout: PROCESS_STARTUP_TIMEOUT_MILLIS })
    .toContain(expected);
}

async function waitForExit(
  fixture: ProcessFixture,
  timeoutMillis = PROCESS_SHUTDOWN_TIMEOUT_MILLIS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fixture.exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`worker did not exit: ${fixture.output()}`));
        }, timeoutMillis);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      const fixture = processFixtures.get(child);
      if (fixture === undefined) {
        failures.push(new Error('Worker process fixture ownership was lost'));
        children.delete(child);
        continue;
      }
      await waitForExit(fixture, FORCE_KILL_TIMEOUT_MILLIS).catch(
        (error: unknown) => failures.push(error),
      );
    }
    children.delete(child);
    processFixtures.delete(child);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Worker process cleanup failed');
});

const processFixtures = new Map<ChildProcess, ProcessFixture>();

describe('compiled worker process lifecycle', () => {
  it.each([
    ['SIGINT', 'disabled'],
    ['SIGINT', 'active'],
    ['SIGTERM', 'disabled'],
    ['SIGTERM', 'active'],
  ] as const)(
    'exits cleanly after %s with %s consumers',
    async (shutdownSignal, mode) => {
      const fixture = startFixture(mode);
      processFixtures.set(fixture.child, fixture);

      await waitForOutput(fixture.output, 'worker.ready');
      const signaledAt = performance.now();
      fixture.child.kill(shutdownSignal);
      const { code, signal } = await waitForExit(fixture);

      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(performance.now() - signaledAt).toBeLessThan(
        PROCESS_SHUTDOWN_TIMEOUT_MILLIS,
      );
      expect(fixture.output()).toContain('database.closed');
      expect(fixture.output()).toContain('telemetry.closed');
      if (mode === 'active') {
        expect(fixture.output()).toContain('consumer.closed');
      }
    },
    PROCESS_TEST_TIMEOUT_MILLIS,
  );

  it(
    'cleans up and exits cleanly after bootstrap failure',
    async () => {
      const fixture = startFixture('bootstrap-failure');
      processFixtures.set(fixture.child, fixture);

      const { code, signal } = await waitForExit(fixture);

      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(fixture.output()).toContain('bootstrap.failed');
      expect(fixture.output()).toContain('database.closed');
      expect(fixture.output()).toContain('telemetry.closed');
    },
    PROCESS_TEST_TIMEOUT_MILLIS,
  );
});
