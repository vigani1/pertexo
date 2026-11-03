import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

function assertWorkerReportIsSafe(output: string, secrets: readonly string[]) {
  if (!output.includes('Owned HTTP dispatch rejected'))
    throw new Error('Worker report missing safe dispatch diagnostic.');
  if (!output.includes('1 failed'))
    throw new Error('Worker report missing expected failure count.');
  if (secrets.some((secret) => output.includes(secret)))
    throw new Error('Worker report contains sensitive material.');
}

it('a secret-bearing report without the required marker fails with fixed diagnostics', () => {
  const secret = `Bearer ${randomUUID()}`;
  let failure: unknown;
  try {
    assertWorkerReportIsSafe(`1 failed\n${secret}`, [secret]);
  } catch (error) {
    failure = error;
  }
  expect(failure instanceof Error).toBe(true);
  if (!(failure instanceof Error))
    throw new Error('Expected safe report failure.');
  expect(
    failure.message === 'Worker report missing safe dispatch diagnostic.',
  ).toBe(true);
  expect(String(failure).includes(secret)).toBe(false);
  expect(failure.stack?.includes(secret)).toBe(false);
});

// Starting a whole child Vitest takes seconds on a busy runner, so this test's
// limit must outlast the child's own, or a slow start reports as a parent timeout.
const CHILD_TIMEOUT_MILLIS = 10_000;

it(
  'the actual failing child reporter never emits endpoint, signature or connection credentials',
  {
    timeout: CHILD_TIMEOUT_MILLIS + 5_000,
  },
  () => {
    const require = createRequire(import.meta.url);
    const endpoint = `endpoint-${randomUUID()}`,
      signature = `v1=${randomUUID()}`,
      credential = `Bearer ${randomUUID()}`;
    const child = spawnSync(
      process.execPath,
      [
        join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
        'run',
        '--config',
        'test/support/editor-browser/http-redaction.probe.config.ts',
      ],
      {
        cwd: new URL('../../../', import.meta.url),
        timeout: CHILD_TIMEOUT_MILLIS,
        encoding: 'utf8',
        env: {
          ...process.env,
          REDACTION_ENDPOINT_KEY: endpoint,
          REDACTION_SIGNATURE: signature,
          REDACTION_CONNECTION_SECRET: credential,
        },
      },
    );
    expect(child.error === undefined).toBe(true);
    expect(child.status).toBe(1);
    const output = child.stdout + child.stderr;
    assertWorkerReportIsSafe(output, [endpoint, signature, credential]);
  },
);
