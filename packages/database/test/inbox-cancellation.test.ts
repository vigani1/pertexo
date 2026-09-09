import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  createWorkspaceDatabase: vi.fn(),
  withWorkspace: vi.fn(),
}));

vi.mock('../src/database.js', () => ({
  createWorkspaceDatabase: databaseMocks.createWorkspaceDatabase,
}));

import type { WorkspaceDatabase } from '../src/database.js';
import { reconcileUnknownOutcomeEvidence } from '../src/execution/unknown-outcome-reconciliation.js';
import { createOperatorRunReplayStore } from '../src/operator/operator-run-replay.js';
import type { WorkspaceTransaction } from '../src/tenant-access/workspace.js';

const checksum = 'a'.repeat(64);
const config = {
  connectionString: 'postgresql://unused.test/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 2,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

function duplicateDatabase(): WorkspaceDatabase {
  return {
    checkCompatibility: vi.fn(),
    checkReadiness: vi.fn(),
    close: databaseMocks.close,
    withWorkspace: databaseMocks.withWorkspace,
  };
}

function interruptibleDatabase() {
  const operationStarted = Promise.withResolvers<undefined>();
  const never = Promise.withResolvers<never>();
  const completionUpdate = vi.fn();
  const state = { rolledBack: false };
  const drizzle = {
    execute: vi.fn(() => {
      operationStarted.resolve(undefined);
      return never.promise;
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ messageId: randomUUID() }]),
        })),
      })),
    })),
    update: completionUpdate,
  };
  const withWorkspace = vi.fn(
    async (
      workspaceId: string,
      operation: (transaction: WorkspaceTransaction) => Promise<unknown>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => {
      const signal = options?.signal;
      if (signal === undefined)
        throw new Error('caller signal was not propagated');
      const aborted = new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('Inbox transaction aborted', {
                    cause: signal.reason,
                  }),
            );
          },
          { once: true },
        );
      });
      try {
        return await Promise.race([
          operation({
            db: drizzle,
            workspaceId,
          } as unknown as WorkspaceTransaction),
          aborted,
        ]);
      } catch (error: unknown) {
        state.rolledBack = true;
        throw error;
      }
    },
  );
  return {
    completionUpdate,
    database: {
      checkCompatibility: vi.fn(),
      checkReadiness: vi.fn(),
      close: databaseMocks.close,
      withWorkspace,
    } as unknown as WorkspaceDatabase,
    operationStarted,
    state,
    withWorkspace,
  };
}

describe('inbox caller cancellation', () => {
  beforeEach(() => {
    databaseMocks.close.mockClear();
    databaseMocks.createWorkspaceDatabase.mockReset();
    databaseMocks.withWorkspace.mockReset();
    databaseMocks.withWorkspace.mockResolvedValue({ status: 'duplicate' });
    databaseMocks.createWorkspaceDatabase.mockReturnValue(duplicateDatabase());
  });

  it('cancels unknown-outcome reconciliation during its inbox transaction', async () => {
    const fixture = interruptibleDatabase();
    const controller = new AbortController();
    const reason = new Error('cancel reconciliation transaction');
    const reconciling = reconcileUnknownOutcomeEvidence(fixture.database, {
      attemptId: randomUUID(),
      delivery: {
        outboxEventId: randomUUID(),
        payloadChecksum: checksum,
      },
      evidenceCommandId: randomUUID(),
      signal: controller.signal,
      workspaceId: randomUUID(),
    });
    const rejection = expect(reconciling).rejects.toBe(reason);
    await fixture.operationStarted.promise;
    controller.abort(reason);
    await rejection;

    expect(fixture.withWorkspace.mock.calls[0]?.[2]).toEqual({
      signal: controller.signal,
    });
    expect(fixture.completionUpdate).not.toHaveBeenCalled();
    expect(fixture.state.rolledBack).toBe(true);
  });

  it('cancels operator replay during its inbox transaction', async () => {
    const fixture = interruptibleDatabase();
    databaseMocks.createWorkspaceDatabase.mockReturnValue(fixture.database);
    const controller = new AbortController();
    const reason = new Error('cancel replay transaction');
    const store = createOperatorRunReplayStore(
      config,
      [
        {
          catalogJson:
            '{"domain":"pertexo.node-compatibility-release","schemaVersion":1}',
          epoch: 1,
          fingerprint: `node-compat:v1:sha256:${'b'.repeat(64)}`,
        },
      ],
      vi.fn(),
    );
    const replaying = store.replay({
      commandId: randomUUID(),
      delivery: {
        outboxEventId: randomUUID(),
        payloadChecksum: checksum,
      },
      signal: controller.signal,
      workspaceId: randomUUID(),
    });
    const rejection = expect(replaying).rejects.toBe(reason);
    await fixture.operationStarted.promise;
    controller.abort(reason);
    await rejection;

    expect(fixture.withWorkspace.mock.calls[0]?.[2]).toEqual({
      signal: controller.signal,
    });
    expect(fixture.completionUpdate).not.toHaveBeenCalled();
    expect(fixture.state.rolledBack).toBe(true);
    await store.close();
  });
});
