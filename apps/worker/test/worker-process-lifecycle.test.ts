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
const children = new Set<ChildProcess>();

async function waitForOutput(
  output: () => string,
  expected: string,
): Promise<void> {
  await expect
    .poll(output, { timeout: PROCESS_STARTUP_TIMEOUT_MILLIS })
    .toContain(expected);
}

async function waitForExit(
  child: ChildProcess,
  output: () => string,
  timeoutMillis = PROCESS_SHUTDOWN_TIMEOUT_MILLIS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`worker did not exit: ${output()}`));
    }, timeoutMillis);
    timeout.unref();
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.removeListener('exit', onExit);
    };
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      cleanup();
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child, () => '', FORCE_KILL_TIMEOUT_MILLIS).catch(
        () => undefined,
      );
    }
    children.delete(child);
  }
});

describe('compiled worker process lifecycle', () => {
  it.each([
    ['SIGINT', 'disabled'],
    ['SIGINT', 'active'],
    ['SIGTERM', 'disabled'],
    ['SIGTERM', 'active'],
  ] as const)(
    'exits cleanly after %s with %s consumers',
    async (shutdownSignal, mode) => {
      const child = spawn(process.execPath, [fixturePath, mode], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        output += chunk;
      });

      await waitForOutput(() => output, 'worker.ready');
      const signaledAt = performance.now();
      child.kill(shutdownSignal);
      const { code, signal } = await waitForExit(child, () => output);

      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(performance.now() - signaledAt).toBeLessThan(
        PROCESS_SHUTDOWN_TIMEOUT_MILLIS,
      );
      expect(output).toContain('database.closed');
      expect(output).toContain('telemetry.closed');
      if (mode === 'active') {
        expect(output).toContain('consumer.closed');
      }
    },
    PROCESS_TEST_TIMEOUT_MILLIS,
  );

  it(
    'cleans up and exits cleanly after bootstrap failure',
    async () => {
      const child = spawn(
        process.execPath,
        [fixturePath, 'bootstrap-failure'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.add(child);
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        output += chunk;
      });

      const { code, signal } = await waitForExit(child, () => output);

      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(output).toContain('bootstrap.failed');
      expect(output).toContain('database.closed');
      expect(output).toContain('telemetry.closed');
    },
    PROCESS_TEST_TIMEOUT_MILLIS,
  );
});
