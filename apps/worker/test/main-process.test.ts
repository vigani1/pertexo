import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const fixturePath = fileURLToPath(
  new URL('./worker-main-process.fixture.mjs', import.meta.url),
);
const entrypointPath = fileURLToPath(
  new URL('../dist/main.js', import.meta.url),
);

function start(path: string, environment: NodeJS.ProcessEnv = process.env) {
  const child = spawn(process.execPath, [path], {
    env: environment,
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

async function waitFor(
  child: ChildProcess,
  output: () => string,
  expected: string,
): Promise<void> {
  await expect
    .poll(
      () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`child exited before ${expected}: ${output()}`);
        }
        return output();
      },
      { timeout: 5_000 },
    )
    .toContain(expected);
}

async function waitForExit(child: ChildProcess, output: () => string) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`worker main child timed out: ${output()}`));
      }, 5_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    },
  );
}

describe('compiled worker main process', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'closes exactly once through the real shutdown owner after %s',
    async (signalName) => {
      const fixture = start(fixturePath);
      try {
        await waitFor(fixture.child, fixture.output, 'worker.active');
        expect(fixture.child.kill(signalName)).toBe(true);
        const result = await waitForExit(fixture.child, fixture.output);

        expect(result).toEqual({ code: 0, signal: null });
        expect(fixture.output()).toContain(
          `"event":"application.closed","signal":"${signalName}"`,
        );
        expect(
          fixture.output().match(/"event":"application.closed"/gu),
        ).toHaveLength(1);
      } finally {
        if (
          fixture.child.exitCode === null &&
          fixture.child.signalCode === null
        ) {
          fixture.child.kill('SIGKILL');
        }
      }
    },
    12_000,
  );

  it('executes the actual main guard and fixed invalid-config formatter', async () => {
    const fixture = start(entrypointPath, {
      ...process.env,
      DATABASE_DISPATCHER_URL: '',
      DATABASE_WORKER_URL: '',
      REDIS_URL: '',
    });
    const result = await waitForExit(fixture.child, fixture.output);

    expect(result).toEqual({ code: 1, signal: null });
    expect(fixture.output()).toContain('"event":"worker.process_failed"');
    expect(fixture.output()).toContain('"errorType":"Error"');
    expect(fixture.output()).not.toContain('DATABASE_WORKER_URL');
  });
});
