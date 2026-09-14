import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const fixturePath = fileURLToPath(
  new URL('./recovery-main-process.fixture.mjs', import.meta.url),
);
const entrypointPath = fileURLToPath(
  new URL('../dist/main.js', import.meta.url),
);

function start(path: string, env = process.env) {
  const child = spawn(process.execPath, [path], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  return { child, output: () => output };
}

async function waitForOutput(
  fixture: ReturnType<typeof start>,
  expected: string,
) {
  await expect.poll(fixture.output, { timeout: 5_000 }).toContain(expected);
  expect(fixture.child.exitCode).toBeNull();
}

async function waitForExit(
  child: ChildProcess,
  output: () => string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`recovery main child timed out: ${output()}`));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe('compiled recovery main process', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'drains the invoked recovery owner after %s',
    async (signalName) => {
      const fixture = start(fixturePath);
      try {
        await waitForOutput(fixture, 'recovery.active');
        expect(fixture.child.kill(signalName)).toBe(true);
        const result = await waitForExit(fixture.child, fixture.output);

        expect(result).toEqual({ code: 0, signal: null });
        for (const event of [
          'coordinator.closed',
          'ledger.closed',
          'artifacts.closed',
          'telemetry.closed',
          'bootstrap.stopped',
        ]) {
          expect(fixture.output()).toContain(event);
        }
      } finally {
        if (
          fixture.child.exitCode === null &&
          fixture.child.signalCode === null
        )
          fixture.child.kill('SIGKILL');
      }
    },
    12_000,
  );

  it('executes the actual main guard and fixed invalid-config formatter', async () => {
    const fixture = start(entrypointPath, {
      ...process.env,
      DATABASE_MAINTENANCE_URL: '',
    });
    const result = await waitForExit(fixture.child, fixture.output);

    expect(result).toEqual({ code: 1, signal: null });
    expect(fixture.output()).toContain(
      '"event":"restore_before_serve.process_failed"',
    );
    expect(fixture.output()).toContain('"errorType":"Error"');
    expect(fixture.output()).not.toContain('DATABASE_MAINTENANCE_URL');
  });
});
