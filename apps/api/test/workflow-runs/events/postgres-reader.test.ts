import type { WorkspaceDatabase } from '@pertexo/database/testing';
import type { WorkspaceTransaction } from '@pertexo/core/testing';
import { readRunEventsAfter } from '@pertexo/core/runs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPostgresRunEventReader } from '../../../src/workflow-runs/events/postgres-reader.js';

vi.mock('@pertexo/core/runs', () => ({ readRunEventsAfter: vi.fn() }));

const readEvents = vi.mocked(readRunEventsAfter);
beforeEach(() => readEvents.mockReset());

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

// This adapter passes transaction identity through; the mocked reader never touches its SQL client.
const transaction = { workspaceId: WORKSPACE_ID } as WorkspaceTransaction;

function databaseWith(
  withWorkspace: WorkspaceDatabase['withWorkspace'],
): WorkspaceDatabase {
  return {
    withWorkspace,
    checkReadiness: () => Promise.reject(new Error('not exercised')),
    applyInstanceCapacity: () => Promise.reject(new Error('not exercised')),
    close: () => Promise.resolve(),
  };
}

describe('PostgreSQL run event reader', () => {
  it('reads through the workspace RLS transaction and maps persisted dates', async () => {
    readEvents.mockResolvedValueOnce({
      events: [
        {
          createdAt: new Date('2026-08-20T00:00:00.000Z'),
          payload: { status: 'running' },
          sequence: 1,
          type: 'run.started',
        },
      ],
      hasMore: false,
      highWaterSequence: 1,
    });
    const database = databaseWith(
      async <T>(
        workspaceId: string,
        operation: (selected: WorkspaceTransaction) => Promise<T>,
        _options?: { readonly signal?: AbortSignal },
      ): Promise<T> => {
        return operation(transaction);
      },
    );
    const withWorkspace = vi.spyOn(database, 'withWorkspace');

    const events = await createPostgresRunEventReader(database).readPage({
      afterSequence: 0,
      limit: 100,
      runId: RUN_ID,
      signal: new AbortController().signal,
      workspaceId: WORKSPACE_ID,
    });

    expect(withWorkspace).toHaveBeenCalledTimes(1);
    const workspaceCall = withWorkspace.mock.calls[0];
    expect(workspaceCall?.[0]).toBe(WORKSPACE_ID);
    const forwardedSignal = workspaceCall?.[2]?.signal;
    expect(forwardedSignal).toBeInstanceOf(AbortSignal);
    expect(readEvents).toHaveBeenCalledTimes(1);
    expect(readEvents).toHaveBeenCalledWith(transaction, {
      afterSequence: 0,
      limit: 100,
      runId: RUN_ID,
    });
    expect(events).toEqual([
      {
        createdAt: '2026-08-20T00:00:00.000Z',
        payload: { status: 'running' },
        sequence: 1,
        type: 'run.started',
      },
    ]);
  });

  it('does not open a database transaction after cancellation', async () => {
    const withWorkspace = vi.fn();
    const database = databaseWith(withWorkspace);
    const controller = new AbortController();
    controller.abort();

    await expect(
      createPostgresRunEventReader(database).readPage({
        afterSequence: 0,
        limit: 100,
        runId: RUN_ID,
        signal: controller.signal,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toEqual([]);
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('returns promptly when an in-flight workspace read is canceled', async () => {
    const controller = new AbortController();
    let rejectRead!: (error: Error) => void;
    const withWorkspace = vi.fn(
      async (
        _workspaceId: string,
        _operation: (transaction: WorkspaceTransaction) => Promise<unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<never> =>
        new Promise<never>((_, reject) => {
          rejectRead = reject;
          options?.signal?.addEventListener(
            'abort',
            () => {
              rejectRead(new Error('query canceled'));
            },
            { once: true },
          );
        }),
    );
    const database = databaseWith(withWorkspace);
    const pending = createPostgresRunEventReader(database).readPage({
      afterSequence: 0,
      limit: 100,
      runId: RUN_ID,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });

    controller.abort();

    await expect(pending).resolves.toEqual([]);
    expect(withWorkspace).toHaveBeenCalledTimes(1);
  });

  it('preserves an ordinary workspace read failure unchanged', async () => {
    const failure = new Error('database unavailable');
    const database = databaseWith(vi.fn().mockRejectedValue(failure));

    await expect(
      createPostgresRunEventReader(database).readPage({
        afterSequence: 7,
        limit: 23,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBe(failure);
  });

  it('does not return a page when cancellation arrives after the database resolves', async () => {
    const controller = new AbortController();
    const operationStarted = Promise.withResolvers<undefined>();
    const releaseOperation = Promise.withResolvers<undefined>();
    readEvents.mockResolvedValueOnce({
      events: [
        {
          createdAt: new Date('2026-08-20T00:00:00.000Z'),
          payload: {},
          sequence: 8,
          type: 'run.started',
        },
      ],
      hasMore: false,
      highWaterSequence: 8,
    });
    const database = databaseWith(
      async <T>(
        _workspaceId: string,
        operation: (selected: WorkspaceTransaction) => Promise<T>,
      ): Promise<T> => {
        const result = await operation(transaction);
        operationStarted.resolve(undefined);
        await releaseOperation.promise;
        return result;
      },
    );
    const pending = createPostgresRunEventReader(database).readPage({
      afterSequence: 7,
      limit: 23,
      runId: RUN_ID,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });

    await operationStarted.promise;
    controller.abort();
    releaseOperation.resolve(undefined);

    await expect(pending).resolves.toEqual([]);
  });
});
