import { describe, expect, it } from 'vitest';

import { awaitWithSignal } from '../src/artifact-request-lifecycle.js';

describe('artifact request lifecycle', () => {
  it('preserves an ordinary operation Error unchanged', async () => {
    const failure = new Error('provider operation failed');

    await expect(
      awaitWithSignal(Promise.reject(failure), new AbortController().signal),
    ).rejects.toBe(failure);
  });

  it('normalizes foreign operation and abort reasons with their cause', async () => {
    const operationFailure = { provider: 'failed' };
    await expect(
      awaitWithSignal(
        // Deliberately model an untrusted provider rejection.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        Promise.reject(operationFailure),
        new AbortController().signal,
      ),
    ).rejects.toEqual(
      new Error('Artifact operation failed', { cause: operationFailure }),
    );

    const controller = new AbortController();
    const pending = awaitWithSignal(
      new Promise<never>(() => undefined),
      controller.signal,
    );
    controller.abort('caller stopped');
    await expect(pending).rejects.toEqual(
      new Error('Artifact operation aborted', { cause: 'caller stopped' }),
    );
  });
});
