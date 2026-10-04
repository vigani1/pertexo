import { describe, expect, it } from 'vitest';
import { createCoordinatorResultPreparationScope } from '../src/execution/coordinator-result-preparation-scope.js';
import { CoordinatorValueWorkStoppedError } from '../src/execution/coordinator-handler.js';
import type { NativeCoordinatorValueOwner } from '@pertexo/database/execution';
import { CallableCompletionStoppedError } from '@pertexo/workflow-model/workflow-call-contract';

const owner: NativeCoordinatorValueOwner = {
  workspaceId: '00000000-1111-4111-8111-111111111111',
  runId: '00000000-1111-4111-8111-111111111112',
  workflowVersionId: '00000000-1111-4111-8111-111111111113',
  expectedRevision: 0,
  delivery: {
    outboxEventId: '00000000-1111-4111-8111-111111111114',
    payloadChecksum: 'a'.repeat(64),
  },
};
const active = {
  kind: 'active',
  databaseNow: '2026-10-04T00:00:00Z',
  deadlineAt: null,
} as const;
const policy = {
  controlPollMillis: 100,
  controlReadTimeoutMillis: 100,
  operationTimeoutMillis: 1000,
};

describe('actual framework precommit scope composition', () => {
  it('propagates the shared database typed-stop through the actual worker lifetime', async () => {
    const scope = createCoordinatorResultPreparationScope(policy);
    const stop = { kind: 'unavailable', reason: 'source_read_failed' } as const;
    await expect(
      scope(
        {
          owner,
          signal: new AbortController().signal,
          inspectOwner: () => Promise.resolve(active),
        },
        () => Promise.reject(new CallableCompletionStoppedError(stop)),
      ),
    ).rejects.toMatchObject({ name: 'CoordinatorValueWorkStoppedError', stop });
  });
  it('initializes independent owner inspection even for literal preparation and rechecks before material escapes', async () => {
    const scope = createCoordinatorResultPreparationScope(policy);
    let inspections = 0;
    let prepared = false;
    const result = await scope(
      {
        owner,
        signal: new AbortController().signal,
        inspectOwner: (input) => {
          expect(input.owner).toEqual(owner);
          inspections++;
          return Promise.resolve(active);
        },
      },
      () => {
        expect(inspections).toBe(1);
        prepared = true;
        return Promise.resolve('original-byte-parameters');
      },
    );
    expect(prepared).toBe(true);
    expect(inspections).toBe(2);
    expect(result).toBe('original-byte-parameters');
  });

  it('does not start preparation after current owner loss', async () => {
    let work = false;
    const scope = createCoordinatorResultPreparationScope(policy);
    await expect(
      scope(
        {
          owner,
          signal: new AbortController().signal,
          inspectOwner: () =>
            Promise.resolve({
              kind: 'stopped',
              stop: { kind: 'stale', revision: 1 },
            }),
        },
        () => {
          work = true;
          return Promise.resolve();
        },
      ),
    ).rejects.toMatchObject({ stop: { kind: 'stale', revision: 1 } });
    expect(work).toBe(false);
  });

  it('cancels and joins stalled preparation on watcher owner loss, without releasing result material', async () => {
    const scope = createCoordinatorResultPreparationScope(policy);
    let inspections = 0;
    let joined = false;
    const result = scope(
      {
        owner,
        signal: new AbortController().signal,
        inspectOwner: () =>
          Promise.resolve(
            ++inspections === 1
              ? active
              : { kind: 'stopped', stop: { kind: 'canceled' } },
          ),
      },
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              // An owned adapter must settle its cleanup before the scope returns.
              void Promise.resolve().then(() => {
                joined = true;
                reject(new DOMException('aborted', 'AbortError'));
              });
            },
            { once: true },
          );
        }),
    );
    await expect(result).rejects.toBeInstanceOf(
      CoordinatorValueWorkStoppedError,
    );
    expect(joined).toBe(true);
    expect(inspections).toBe(2);
  });

  it('joins preparation cancellation on context abort and preserves the typed stop', async () => {
    const scope = createCoordinatorResultPreparationScope(policy);
    const context = new AbortController();
    let joined = false;
    const result = scope(
      {
        owner,
        signal: context.signal,
        inspectOwner: () => Promise.resolve(active),
      },
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              joined = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
          context.abort();
        }),
    );
    await expect(result).rejects.toMatchObject({
      stop: { kind: 'context_aborted' },
    });
    expect(joined).toBe(true);
  });

  it('refuses late material after post-preparation revision loss', async () => {
    let inspections = 0;
    const scope = createCoordinatorResultPreparationScope(policy);
    await expect(
      scope(
        {
          owner,
          signal: new AbortController().signal,
          inspectOwner: () =>
            Promise.resolve(
              ++inspections === 1
                ? active
                : { kind: 'stopped', stop: { kind: 'stale', revision: 1 } },
            ),
        },
        () => Promise.resolve('late-bytes'),
      ),
    ).rejects.toMatchObject({ stop: { kind: 'stale', revision: 1 } });
  });

  it('fails closed on watcher failure and joins owned preparation without classifying it as invalid child output', async () => {
    const scope = createCoordinatorResultPreparationScope(policy);
    const failure = new Error('actual control read failed');
    let reads = 0;
    let joined = false;
    const result = scope(
      {
        owner,
        signal: new AbortController().signal,
        inspectOwner: () =>
          ++reads === 1 ? Promise.resolve(active) : Promise.reject(failure),
      },
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              joined = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    await expect(result).rejects.toBe(failure);
    expect(joined).toBe(true);
  });
});
