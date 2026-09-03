import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const fixturePath = fileURLToPath(
  new URL('./worker-process-lifecycle.fixture.mjs', import.meta.url),
);
const PROCESS_EXIT_TIMEOUT_MILLIS = 5_000;

async function waitForOutput(
  output: () => string,
  expected: string,
): Promise<void> {
  await expect
    .poll(output, { timeout: PROCESS_EXIT_TIMEOUT_MILLIS })
    .toContain(expected);
}

describe('compiled worker process lifecycle', () => {
  it.each(['disabled', 'active'] as const)(
    'exits cleanly after SIGTERM with %s consumers',
    async (mode) => {
      const child = spawn(process.execPath, [fixturePath, mode], {
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

      await waitForOutput(() => output, 'worker.ready');
      const signaledAt = performance.now();
      child.kill('SIGTERM');
      const [code, signal] = await Promise.race([
        once(child, 'exit'),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`worker did not exit: ${output}`)),
            PROCESS_EXIT_TIMEOUT_MILLIS,
          ).unref();
        }),
      ]);

      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(performance.now() - signaledAt).toBeLessThan(
        PROCESS_EXIT_TIMEOUT_MILLIS,
      );
      expect(output).toContain('database.closed');
      expect(output).toContain('telemetry.closed');
      if (mode === 'active') expect(output).toContain('consumer.closed');
    },
  );

  it('cleans up and exits cleanly after bootstrap failure', async () => {
    const child = spawn(process.execPath, [fixturePath, 'bootstrap-failure'], {
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

    const [code, signal] = await Promise.race([
      once(child, 'exit'),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error(`worker did not exit: ${output}`)),
          PROCESS_EXIT_TIMEOUT_MILLIS,
        ).unref();
      }),
    ]);

    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(output).toContain('bootstrap.failed');
    expect(output).toContain('database.closed');
    expect(output).toContain('telemetry.closed');
  });
});
