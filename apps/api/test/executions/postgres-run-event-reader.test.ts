import type {
  WorkspaceDatabase,
  WorkspaceTransaction,
} from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import { createPostgresRunEventReader } from '../../src/executions/postgres-run-event-reader.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

describe('PostgreSQL run event reader', () => {
  it('reads through the workspace RLS transaction and maps persisted dates', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ high_water: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            created_at: new Date('2026-08-20T00:00:00.000Z'),
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
    expect(
      (withWorkspace.mock.calls[0]?.[2] as { signal?: AbortSignal } | undefined)
        ?.signal,
    ).toBeInstanceOf(AbortSignal);
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
});
