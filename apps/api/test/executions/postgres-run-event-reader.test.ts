import type {
  WorkspaceDatabase,
  WorkspaceTransaction,
} from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import { createPostgresRunEventReader } from '../../src/executions/postgres-run-event-reader.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

function sqlBoundValues(value: unknown, output: unknown[] = []): unknown[] {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    output.push(value);
    return output;
  }
  if (typeof value !== 'object' || value === null) return output;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'value') && Object.hasOwn(record, 'encoder')) {
    output.push(record.value);
    return output;
  }
  const chunks = record.queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) sqlBoundValues(chunk, output);
  }
  return output;
}

describe('PostgreSQL run event reader', () => {
  it('reads through the workspace RLS transaction and maps persisted dates', async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          created_at: new Date('2026-08-20T00:00:00.000Z'),
          high_water: 1,
          payload: { status: 'running' },
          sequence: 1,
          type: 'run.started',
        },
      ],
    });
    const transaction = {
      db: { execute },
      workspaceId: WORKSPACE_ID,
    } as unknown as WorkspaceTransaction;
    const withWorkspace = vi.fn(
      async <T>(
        workspaceId: string,
        operation: (selected: WorkspaceTransaction) => Promise<T>,
        options?: { readonly signal?: AbortSignal },
      ): Promise<T> => {
        void options;
        return operation(transaction);
      },
    );
    const database = {
      checkReadiness: vi.fn(),
      close: vi.fn(),
      withWorkspace,
    } as unknown as WorkspaceDatabase;

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
    expect(sqlBoundValues(execute.mock.calls[0]?.[0])).toEqual([
      WORKSPACE_ID,
      RUN_ID,
      WORKSPACE_ID,
      RUN_ID,
      0,
      101,
    ]);
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
    const database = { withWorkspace } as unknown as WorkspaceDatabase;
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
    const database = { withWorkspace } as unknown as WorkspaceDatabase;
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
    const database = {
      withWorkspace: vi.fn().mockRejectedValue(failure),
    } as unknown as WorkspaceDatabase;

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
    const execute = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          created_at: new Date('2026-08-20T00:00:00.000Z'),
          high_water: 8,
          payload: { schemaVersion: 1 },
          sequence: 8,
          type: 'run.started',
        },
      ],
    });
    const transaction = {
      db: { execute },
      workspaceId: WORKSPACE_ID,
    } as unknown as WorkspaceTransaction;
    const database = {
      withWorkspace: vi.fn(
        async <T>(
          _workspaceId: string,
          operation: (selected: WorkspaceTransaction) => Promise<T>,
        ): Promise<T> => {
          const result = await operation(transaction);
          operationStarted.resolve(undefined);
          await releaseOperation.promise;
          return result;
        },
      ),
    } as unknown as WorkspaceDatabase;
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
