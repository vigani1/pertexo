import { Writable } from 'node:stream';
import { createVitest } from 'vitest/node';
import { createEditorControlledHttpTarget } from './controlled-http.js';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

function assertWorkerReportIsSafe(output: string, secrets: readonly string[]) {
  if (!output.includes('Owned HTTP dispatch rejected'))
    throw new Error('Worker report missing safe dispatch diagnostic.');
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

it('the actual Vitest error formatter never emits endpoint, signature or connection credentials', async () => {
  const endpoint = `endpoint-${randomUUID()}`;
  const signature = `v1=${randomUUID()}`;
  const credential = `Bearer ${randomUUID()}`;
  let output = '';
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  // Use the reporter's public logger with real streams, without running another
  // test engine. Middleware mode and disabled API/watch open no listening port.
  const reporter = await createVitest(
    'test',
    {
      config: false,
      watch: false,
      reporters: [],
      api: false,
    },
    { server: { middlewareMode: true, hmr: false, watch: null } },
    {
      stdout: sink,
      stderr: sink,
    },
  );
  const target = createEditorControlledHttpTarget(credential);
  try {
    await target.start();
    const failure: unknown = await target.transport
      .dispatch({
        url: new URL(
          `https://invalid.example.test/${endpoint}?signature=${signature}`,
        ),
        method: 'POST',
        address: { address: '8.8.8.8', family: 4 },
        headers: { authorization: credential },
        body: Buffer.from('{}'),
        timeoutMillis: 1_000,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    reporter.logger.printError(failure);
    assertWorkerReportIsSafe(output, [endpoint, signature, credential]);

    // A real formatted leak must trip the same check, with a fixed diagnostic.
    output = '';
    reporter.logger.printError(
      new Error(`Owned HTTP dispatch rejected: ${credential}`),
    );
    expect(() => { assertWorkerReportIsSafe(output, [credential]); }).toThrow(
      'Worker report contains sensitive material.',
    );
  } finally {
    try {
      await target.close();
    } finally {
      await reporter.close();
      sink.destroy();
    }
  }
});
