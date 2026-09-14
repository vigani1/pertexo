import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const fixturePath = fileURLToPath(
  new URL('./operator-main-process.fixture.mjs', import.meta.url),
);
const entrypointPath = fileURLToPath(
  new URL('../dist/main.js', import.meta.url),
);

function start(path: string, arguments_: string[] = [], env = process.env) {
  const child = spawn(process.execPath, [path, ...arguments_], {
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
  child: ChildProcess,
  output: () => string,
  expected: string,
) {
  await expect.poll(() => output(), { timeout: 5_000 }).toContain(expected);
  expect(child.exitCode).toBeNull();
}

async function waitForExit(child: ChildProcess, output: () => string) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`operator main child timed out: ${output()}`));
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

describe('compiled operator command main process', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'delivers %s to the injected command owner and exits cleanly',
    async (signalName) => {
      const fixture = start(fixturePath, ['active']);
      try {
        await waitForOutput(fixture.child, fixture.output, 'command.active');
        expect(fixture.child.kill(signalName)).toBe(true);
        const result = await waitForExit(fixture.child, fixture.output);

        expect(result).toEqual({ code: 0, signal: null });
        expect(fixture.output()).toContain('command.closed');
        expect(fixture.output()).toContain('bootstrap.stopped');
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

  it('writes the successful command result as valid JSON', async () => {
    const fixture = start(fixturePath, ['success']);
    const result = await waitForExit(fixture.child, fixture.output);
    const lines = fixture.output().trim().split('\n');
    const commandResult = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.status === 'missing');

    expect(result).toEqual({ code: 0, signal: null });
    expect(commandResult).toMatchObject({
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'missing',
    });
  });

  it('executes the actual main guard and fixed invalid-config formatter', async () => {
    const fixture = start(entrypointPath, [], {
      ...process.env,
      DATABASE_OPERATOR_URL: '',
      OPERATOR_COMMAND_TYPE: '',
    });
    const result = await waitForExit(fixture.child, fixture.output);

    expect(result).toEqual({ code: 1, signal: null });
    expect(fixture.output()).toContain(
      '"event":"operator_command.process_failed"',
    );
    expect(fixture.output()).toContain('"errorType":"Error"');
    expect(fixture.output()).not.toContain('DATABASE_OPERATOR_URL');
  });
});
