import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

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

  it.each(['success', 'failure'] as const)(
    'owns a later operation %s when cancellation already won',
    async (outcome) => {
      const controller = new AbortController();
      const abortReason = new Error('already cancelled');
      controller.abort(abortReason);
      let resolveOperation: ((value: string) => void) | undefined;
      let rejectOperation: ((reason: unknown) => void) | undefined;
      const operation = new Promise<string>((resolve, reject) => {
        resolveOperation = resolve;
        rejectOperation = reject;
      });

      const result = awaitWithSignal(operation, controller.signal);
      await expect(result).rejects.toBe(abortReason);
      if (outcome === 'success') resolveOperation?.('late value');
      else rejectOperation?.(new Error('late provider failure'));
      await Promise.resolve();

      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    },
  );

  it.each(['prototype', 'revoked'] as const)(
    'normalizes a hostile %s rejection without stranding settlement',
    async (shape) => {
      const target = new Error('hidden');
      const failure =
        shape === 'prototype'
          ? new Proxy(target, {
              getPrototypeOf() {
                throw new Error('prototype trap');
              },
            })
          : (() => {
              const revocable = Proxy.revocable(target, {});
              revocable.revoke();
              return revocable.proxy;
            })();

      let caught: unknown;
      try {
        await awaitWithSignal(
          Promise.reject(failure),
          new AbortController().signal,
        );
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('Artifact operation failed');
      expect((caught as Error).cause).toBe(failure);
    },
  );

  it('normalizes a hostile cancellation reason and removes its listener', async () => {
    const controller = new AbortController();
    const reason = new Proxy(new Error('hidden'), {
      getPrototypeOf() {
        throw new Error('prototype trap');
      },
    });
    const result = awaitWithSignal(
      new Promise<never>(() => undefined),
      controller.signal,
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    controller.abort(reason);

    let caught: unknown;
    try {
      await result;
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('Artifact operation aborted');
    expect((caught as Error).cause).toBe(reason);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not emit an unhandled rejection for pre-abort plus late failure', () => {
    const fixture = fileURLToPath(
      new URL(
        './artifact-request-lifecycle-process.fixture.ts',
        import.meta.url,
      ),
    );
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
      encoding: 'utf8',
      timeout: 5_000,
    });

    expect(child.status, child.stderr).toBe(0);
    expect(child.signal).toBeNull();
    expect(JSON.parse(child.stdout)).toEqual({
      originalAbort: true,
      unhandled: 0,
    });
  });

  it('settles once when operation completion and abort compete', async () => {
    const controller = new AbortController();
    let resolveOperation: ((value: string) => void) | undefined;
    const operation = new Promise<string>((resolve) => {
      resolveOperation = resolve;
    });
    const result = awaitWithSignal(operation, controller.signal);
    const observed = vi.fn();
    void result.then(observed, observed);

    controller.abort(new Error('cancelled'));
    resolveOperation?.('late');
    await expect(result).rejects.toThrow('cancelled');
    await Promise.resolve();

    expect(observed).toHaveBeenCalledOnce();
  });
});
