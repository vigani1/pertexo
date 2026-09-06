import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const fixturePath = fileURLToPath(
  new URL('./lifecycle-command-process.fixture.mjs', import.meta.url),
);
const entrypointPath = fileURLToPath(
  new URL('../dist/main.js', import.meta.url),
);
const STARTUP_TIMEOUT_MILLIS = 5_000;
const SHUTDOWN_TIMEOUT_MILLIS = 5_000;
const PROCESS_TEST_TIMEOUT_MILLIS =
  STARTUP_TIMEOUT_MILLIS + SHUTDOWN_TIMEOUT_MILLIS + 1_000;
const FORCE_KILL_TIMEOUT_MILLIS = 1_000;

interface ChildState {
  output: string;
  error: Error | undefined;
}

interface Fixture {
  child: ChildProcess;
  markerDirectory: string;
  markerPath: string;
  onError: (error: Error) => void;
  state: ChildState;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const { child, markerDirectory, onError, state } = fixture;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child, state, FORCE_KILL_TIMEOUT_MILLIS, {
        ignoreError: true,
      }).catch(() => undefined);
    }
    child.removeListener('error', onError);
    await rm(markerDirectory, { force: true, recursive: true });
  }
});

async function startFixture(mode: string): Promise<Fixture> {
  const markerDirectory = await mkdtemp(
    join(tmpdir(), 'pertexo-lifecycle-command-'),
  );
  const markerPath = join(markerDirectory, 'ready');
  const entrypoint = mode === 'entrypoint-failure';
  const child = spawn(
    process.execPath,
    entrypoint ? [entrypointPath] : [fixturePath, mode, markerPath],
    {
      env: entrypoint
        ? { ...process.env, LIFECYCLE_COMMAND_LEASE_OWNER: '' }
        : undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const state: ChildState = { error: undefined, output: '' };
  const onError = (error: Error): void => {
    state.error = error;
    state.output += `child error: ${error.message}\n`;
  };
  child.on('error', onError);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    state.output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    state.output += chunk;
  });
  const fixture = { child, markerDirectory, markerPath, onError, state };
  fixtures.push(fixture);
  return fixture;
}

async function waitForOutput(
  child: ChildProcess,
  state: ChildState,
  expected: string,
  timeoutMillis: number,
): Promise<void> {
  if (state.error !== undefined) {
    throw state.error;
  }
  if (state.output.includes(expected)) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `child exited before ${expected} (code=${String(child.exitCode)}, signal=${String(child.signalCode)}): ${state.output}`,
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`child did not emit ${expected}: ${state.output}`));
    }, timeoutMillis);
    const onData = (): void => {
      if (!state.output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `child exited before ${expected} (code=${String(code)}, signal=${String(signal)}): ${state.output}`,
        ),
      );
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onData);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
    if (state.error !== undefined) {
      cleanup();
      reject(state.error);
    } else if (child.exitCode !== null || child.signalCode !== null) {
      cleanup();
      reject(
        new Error(
          `child exited before ${expected} (code=${String(child.exitCode)}, signal=${String(child.signalCode)}): ${state.output}`,
        ),
      );
    }
  });
}

async function waitForExit(
  child: ChildProcess,
  state: ChildState,
  timeoutMillis = SHUTDOWN_TIMEOUT_MILLIS,
  options: { readonly ignoreError?: boolean } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const ignoreError = options.ignoreError === true;
  if (state.error !== undefined && !ignoreError) {
    throw state.error;
  }
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`child did not exit: ${state.output}`));
    }, timeoutMillis);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error): void => {
      if (ignoreError) return;
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    if (state.error !== undefined && !ignoreError) {
      cleanup();
      reject(state.error);
    } else if (child.exitCode !== null || child.signalCode !== null) {
      cleanup();
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

async function markerExists(markerPath: string): Promise<boolean> {
  try {
    await access(markerPath);
    return true;
  } catch {
    return false;
  }
}

describe('compiled lifecycle command process lifecycle', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'clears readiness and exits cleanly after %s while active',
    async (shutdownSignal) => {
      const { child, markerPath, state } = await startFixture('active');
      await waitForOutput(
        child,
        state,
        'readiness.marked',
        STARTUP_TIMEOUT_MILLIS,
      );
      await expect
        .poll(() => markerExists(markerPath), {
          timeout: STARTUP_TIMEOUT_MILLIS,
        })
        .toBe(true);

      expect(child.kill(shutdownSignal)).toBe(true);
      const { code, signal } = await waitForExit(child, state);

      expect(signal).toBeNull();
      expect(code).toBe(0);
      await expect
        .poll(() => markerExists(markerPath), {
          timeout: SHUTDOWN_TIMEOUT_MILLIS,
        })
        .toBe(false);
      expect(state.output).toContain('database.closed');
      expect(state.output).toContain('ledger.closed');
      expect(state.output).toContain('telemetry.closed');
      expect(state.output).toContain('bootstrap.completed');
      expect(state.output).not.toContain('process_failed');
    },
    PROCESS_TEST_TIMEOUT_MILLIS,
  );

  it(
    'cleans the marker and constructed ledger after bootstrap failure',
    async () => {
      const { child, markerPath, state } =
        await startFixture('bootstrap-failure');
      await waitForOutput(
        child,
        state,
        'bootstrap.failed',
        STARTUP_TIMEOUT_MILLIS,
      );
      const { code, signal } = await waitForExit(child, state);

      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(await markerExists(markerPath)).toBe(false);
      expect(state.output).toContain('readiness.cleared');
      expect(state.output).toContain('ledger.closed');
      expect(state.output).toContain('telemetry.closed');
    },
    PROCESS_TEST_TIMEOUT_MILLIS,
  );

  it(
    'runs the compiled entrypoint failure formatter with a sanitized exit',
    async () => {
      const { child, state } = await startFixture('entrypoint-failure');
      const { code, signal } = await waitForExit(
        child,
        state,
        STARTUP_TIMEOUT_MILLIS,
      );

      expect(signal).toBeNull();
      expect(code).toBe(1);
      expect(state.output).toContain(
        '"event":"lifecycle_command.process_failed"',
      );
      expect(state.output).toContain('"errorType":"ZodError"');
      expect(state.output).not.toContain('LIFECYCLE_COMMAND_LEASE_OWNER');
    },
    PROCESS_TEST_TIMEOUT_MILLIS,
  );
});
