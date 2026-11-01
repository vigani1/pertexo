import { problemResult } from '../../support/problem.js';
import { runFailure } from '../../../src/problems/context/normalize.js';

import { expect, it, vi } from 'vitest';
import { WorkflowPublishedVersionConflictError } from '@pertexo/core/runs';

import { createPostgresWorkflowRunPersistence } from '../../../src/workflow-runs/postgres-persistence.js';
import { usageCapacitySnapshot } from '../usage/capacity.fixture.js';
import {
  ExecutionStateConflictError,
  IdempotencyRequestConflictError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
  WorkspaceAccessDeniedError,
  WorkflowRunNotExecutableError as DatabaseWorkflowRunNotExecutableError,
  WorkflowRunNotFoundError as DatabaseWorkflowRunNotFoundError,
  type WorkflowRunDatabase,
} from '@pertexo/core/testing';
import {
  workspaceId,
  workflowVersionId,
  runId,
  actorId,
  run,
  statisticsRecord,
  databaseWith,
  adapterConfig,
  invokePersistence,
} from './fixture.js';

export function registerForwardsCapacityReadsCancellationWithoutChanging(): void {
  it('forwards capacity reads and cancellation without changing exact values', async () => {
    const usageCapacity = vi
      .fn<WorkflowRunDatabase['usageCapacity']>()
      .mockResolvedValue(usageCapacitySnapshot());
    const adapter = createPostgresWorkflowRunPersistence(
      adapterConfig,
      databaseWith({ usageCapacity }),
    );
    const signal = new AbortController().signal;
    await expect(
      adapter.persistence.usageCapacity({ workspaceId, signal }),
    ).resolves.toEqual(usageCapacitySnapshot());
    expect(usageCapacity).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      signal,
    });
    const failure = new Error('unknown persistence failure');
    usageCapacity.mockRejectedValue(failure);
    await expect(
      adapter.persistence.usageCapacity({ workspaceId }),
    ).rejects.toBe(failure);
  });

  it('does not disclose capacity when workspace access is lost at the snapshot', async () => {
    const usageCapacity = vi
      .fn<WorkflowRunDatabase['usageCapacity']>()
      .mockRejectedValue(
        new WorkspaceAccessDeniedError('private lifecycle reason'),
      );
    const adapter = createPostgresWorkflowRunPersistence(
      adapterConfig,
      databaseWith({ usageCapacity }),
    );
    await expect(
      problemResult(
        adapter.persistence.usageCapacity({ workspaceId }),
        runFailure,
      ),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
  });

  it.each([
    [
      new WorkflowPublishedVersionConflictError(workflowVersionId, runId),
      'workflow.published_version_conflict',
    ],
  ])('maps checked admission error safely', async (failure, code) => {
    const adapter = createPostgresWorkflowRunPersistence(
      adapterConfig,
      databaseWith({ start: vi.fn().mockRejectedValue(failure) }),
    );
    await expect(
      problemResult(invokePersistence(adapter, 'start'), runFailure),
    ).rejects.toMatchObject({
      code,
    });
  });

  it.each(['start', 'replay', 'get', 'cancel'] as const)(
    'maps database run-not-found from %s to the public not-found error',
    async (operation) => {
      const failure = new DatabaseWorkflowRunNotFoundError();
      const database = databaseWith({
        [operation]: vi.fn().mockRejectedValue(failure),
      });
      const adapter = createPostgresWorkflowRunPersistence(
        adapterConfig,
        database,
      );

      await expect(
        problemResult(invokePersistence(adapter, operation), runFailure),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
    },
  );

  it.each(['start', 'replay'] as const)(
    'maps database not-executable and idempotency errors from %s',
    async (operation) => {
      for (const [failure, expected] of [
        [new DatabaseWorkflowRunNotExecutableError(), 'workflow.not_published'],
        [new IdempotencyRequestConflictError(), 'request.idempotency_conflict'],
      ] as const) {
        const database = databaseWith({
          [operation]: vi.fn().mockRejectedValue(failure),
        });
        const adapter = createPostgresWorkflowRunPersistence(
          adapterConfig,
          database,
        );

        await expect(
          problemResult(invokePersistence(adapter, operation), runFailure),
        ).rejects.toMatchObject({ code: expected });
      }
    },
  );

  it.each([
    [new WorkspaceRunQuotaExceededError(), 'workspace.quota_exceeded'],
    [new WorkspaceRunAdmissionDeniedError(), 'workspace.conflict'],
  ] as const)(
    'maps acceptance admission failure $expected without leaking its database error',
    async (failure, expected) => {
      for (const operation of ['start', 'replay'] as const) {
        const database = databaseWith({
          [operation]: vi.fn().mockRejectedValue(failure),
        });
        const adapter = createPostgresWorkflowRunPersistence(
          adapterConfig,
          database,
        );

        await expect(
          problemResult(invokePersistence(adapter, operation), runFailure),
        ).rejects.toMatchObject({ code: expected });
      }
    },
  );

  it.each([
    'execution.run_terminal',
    'execution.cancel_request_conflict',
  ] as const)('maps cancel conflict %s to not-cancelable', async (message) => {
    const database = databaseWith({
      cancel: vi
        .fn()
        .mockRejectedValue(new ExecutionStateConflictError(message)),
    });
    const adapter = createPostgresWorkflowRunPersistence(
      adapterConfig,
      database,
    );

    await expect(
      problemResult(invokePersistence(adapter, 'cancel'), runFailure),
    ).rejects.toMatchObject({ code: 'run.not_cancelable' });
  });

  it('forwards a statistics read and returns its snapshot unchanged', async () => {
    const statistics = vi
      .fn<WorkflowRunDatabase['statistics']>()
      .mockResolvedValue(statisticsRecord());
    const adapter = createPostgresWorkflowRunPersistence(
      adapterConfig,
      databaseWith({ statistics }),
    );

    await expect(invokePersistence(adapter, 'statistics')).resolves.toEqual(
      statisticsRecord(),
    );
    expect(statistics).toHaveBeenCalledWith({
      actorId,
      workspaceId,
      window: '24h',
      includeWorkflows: false,
      includeWorkflowName: true,
    });
  });

  it.each(['start', 'replay', 'get', 'cancel', 'statistics'] as const)(
    'preserves an unknown %s persistence failure by identity',
    async (operation) => {
      const failure = Object.freeze({ operation, reason: 'unknown' });
      const database = databaseWith({
        [operation]: vi.fn().mockRejectedValue(failure),
      });
      const adapter = createPostgresWorkflowRunPersistence(
        adapterConfig,
        database,
      );

      await expect(invokePersistence(adapter, operation)).rejects.toBe(failure);
    },
  );

  it('publishes no hint for replayed acceptance or unchanged cancellation', async () => {
    const publish = vi.fn().mockResolvedValue({ receivers: 0 });
    const database = databaseWith({
      replay: vi.fn<WorkflowRunDatabase['replay']>().mockResolvedValue({
        run: { ...run(), triggerType: 'replay' },
        replayed: true,
      }),
      cancel: vi.fn<WorkflowRunDatabase['cancel']>().mockResolvedValue({
        run: run(),
        alreadyRequested: true,
        eventSequence: null,
      }),
    });
    const adapter = createPostgresWorkflowRunPersistence(
      adapterConfig,
      database,
      {
        close: vi.fn().mockResolvedValue(undefined),
        publish,
        resync: vi.fn().mockResolvedValue({ receivers: 0 }),
      },
    );

    await expect(invokePersistence(adapter, 'replay')).resolves.toMatchObject({
      replayed: true,
    });
    await expect(invokePersistence(adapter, 'cancel')).resolves.toMatchObject({
      alreadyRequested: true,
    });
    expect(publish).not.toHaveBeenCalled();
  });
}
