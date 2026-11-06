import { describe, expect, it, vi } from 'vitest';
import { problemResult } from '../support/problem.js';
import { runFailure } from '../../src/problems/context/normalize.js';
import {
  WorkflowPublishedVersionConflictError,
  createInitialCheckpoint,
} from '@pertexo/core/runs';
import { createPostgresWorkflowRunPersistence } from '../../src/workflow-runs/postgres-persistence.js';
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
  databaseWith,
  adapterConfig,
  invokePersistence,
  workflowId,
  expectInitialCheckpoint,
  executable,
  forEachExecutable,
  parallelExecutable,
  projection,
} from './postgres-persistence/postgres-persistence.fixture.js';
import { workflowNode } from '../support/workflow-node.js';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  parseCheckpoint,
  WorkflowEngineError,
} from '@pertexo/workflow-engine/server';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { parseDatabaseConfig } from '@pertexo/database/testing';

describe('PostgreSQL workflow run persistence adapter', () => {
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
        adapter.persistence.usageCapacity({ workspaceId, actorId }),
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

  it('does not turn committed acceptance or cancellation into rejection when hint publication fails', async () => {
    const publishFailure = new Error('Redis unavailable');
    const publish = vi.fn().mockRejectedValue(publishFailure);
    const database = databaseWith();
    const adapter = createPostgresWorkflowRunPersistence(
      adapterConfig,
      database,
      {
        close: vi.fn().mockResolvedValue(undefined),
        publish,
        resync: vi.fn().mockResolvedValue({ receivers: 0 }),
      },
    );

    await expect(invokePersistence(adapter, 'start')).resolves.toMatchObject({
      replayed: false,
    });
    await expect(invokePersistence(adapter, 'cancel')).resolves.toMatchObject({
      alreadyRequested: false,
    });
    expect(publish.mock.calls).toEqual([
      [{ workspaceId, runId, sequence: 1 }],
      [{ workspaceId, runId, sequence: 2 }],
    ]);
  });

  it('passes run data reads through and maps a hidden run to not found', async () => {
    const readInput = vi
      .fn<WorkflowRunDatabase['readInput']>()
      .mockResolvedValue({ kind: 'inline', value: { rows: 42 } });
    const database = databaseWith({
      readVariables: () => Promise.resolve({ revision: 0, values: {} }),
      readInput,
      readNodeRunDiagnostics: () => Promise.resolve(undefined),
      readNodeRunOutput: vi
        .fn<WorkflowRunDatabase['readNodeRunOutput']>()
        .mockRejectedValue(new DatabaseWorkflowRunNotFoundError()),
    });
    const adapter = createPostgresWorkflowRunPersistence(
      adapterConfig,
      database,
    );
    await expect(
      adapter.persistence.readInput({ actorId, workspaceId, runId }),
    ).resolves.toEqual({ kind: 'inline', value: { rows: 42 } });
    expect(readInput).toHaveBeenCalledWith({ actorId, workspaceId, runId });
    await expect(
      problemResult(
        adapter.persistence.readNodeRunOutput({
          actorId,
          workspaceId,
          runId,
          nodeRunId: runId,
        }),
        runFailure,
      ),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
  });

  it('forwards an accepted replay and publishes its durable wake-up hint', async () => {
    const replay = vi.fn<WorkflowRunDatabase['replay']>().mockResolvedValue({
      run: { ...run(), triggerType: 'replay' },
      replayed: false,
    });
    const publish = vi.fn().mockResolvedValue({ receivers: 1 });
    const database = {
      canRead: () => Promise.resolve(true),
      start: vi.fn<WorkflowRunDatabase['start']>(),
      replay,
      get: vi.fn<WorkflowRunDatabase['get']>().mockResolvedValue(undefined),
      list: vi
        .fn<WorkflowRunDatabase['list']>()
        .mockResolvedValue({ items: [] }),
      statistics: vi.fn<WorkflowRunDatabase['statistics']>(),
      recovery: vi.fn<WorkflowRunDatabase['recovery']>(),
      recover: vi.fn<WorkflowRunDatabase['recover']>(),
      usageTrends: vi.fn<WorkflowRunDatabase['usageTrends']>(),
      usageCapacity: vi.fn<WorkflowRunDatabase['usageCapacity']>(),
      cancel: vi.fn<WorkflowRunDatabase['cancel']>(),
      readVariables: () => Promise.resolve({ revision: 0, values: {} }),
      readInput: vi.fn<WorkflowRunDatabase['readInput']>(),
      readNodeRunDiagnostics: () => Promise.resolve(undefined),
      readNodeRunOutput: vi.fn<WorkflowRunDatabase['readNodeRunOutput']>(),
      readNodeRunInput: vi.fn<WorkflowRunDatabase['readNodeRunInput']>(),
      stepHealth: vi.fn<WorkflowRunDatabase['stepHealth']>(),
      stepRuns: vi.fn<WorkflowRunDatabase['stepRuns']>(),
      close: vi.fn<WorkflowRunDatabase['close']>().mockResolvedValue(),
    } satisfies WorkflowRunDatabase;
    const adapter = createPostgresWorkflowRunPersistence(
      parseDatabaseConfig({
        connectionString: 'postgresql://unused.invalid/pertexo',
      }),
      database,
      {
        close: vi.fn().mockResolvedValue(undefined),
        publish,
        resync: vi.fn().mockResolvedValue({ receivers: 1 }),
      },
    );

    await expect(
      adapter.persistence.replay({
        actorId,
        workspaceId,
        sourceRunId: runId,
        workflowVersionId,
        idempotencyKeyHash: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
        scope: `workflow:${runId}:replay`,
        input: { customerId: 'customer-42' },
      }),
    ).resolves.toMatchObject({ run: { id: runId }, replayed: false });
    const replayCall = replay.mock.calls[0]?.[0];
    expect(replayCall).toBeDefined();
    expect(replayCall).toMatchObject({
      actorId,
      workspaceId,
      sourceRunId: runId,
      workflowVersionId,
      scope: `workflow:${runId}:replay`,
      input: { customerId: 'customer-42' },
    });
    expect(typeof replayCall?.checkpointFactory).toBe('function');
    expect(publish).toHaveBeenCalledWith({
      workspaceId,
      runId,
      sequence: 1,
    });
  });

  it('initializes the checkpoint for a verified Condition executable', () => {
    const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
    const compiled = buildWorkflowExecutable({
      catalog,
      graph: {
        settings: { maxRunDurationMs: 60_000 },
        nodes: [
          workflowNode('manual', 'core.manual'),
          workflowNode('condition', 'core.condition', {
            position: { x: 10, y: 0 },
            inputMappings: {
              condition: { kind: 'literal', value: true },
            },
          }),
          workflowNode('terminate', 'core.terminate', {
            position: { x: 20, y: 0 },
            inputMappings: {
              result: {
                kind: 'node_output',
                nodeId: 'condition',
                path: '$',
              },
            },
          }),
        ],
        edges: [
          {
            id: 'manual-condition',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'condition', port: 'in' },
          },
          {
            id: 'condition-terminate',
            source: { nodeId: 'condition', port: 'true' },
            target: { nodeId: 'terminate', port: 'in' },
          },
        ],
      },
    });
    const checkpoint = createInitialCheckpoint(
      {
        id: workflowVersionId,
        workspaceId,
        workflowId,
        versionNumber: 1,
        checksum: compiled.checksum,
        executableJson: compiled.envelope,
      },
      {
        catalog,
      },
    );

    expectInitialCheckpoint(checkpoint);
    expect(parseCheckpoint(checkpoint.checkpoint)).toMatchObject({
      branchSelections: [],
    });
  });

  it('initializes the checkpoint for a verified Switch executable', () => {
    const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
    const compiled = buildWorkflowExecutable({
      catalog,
      graph: {
        settings: { maxRunDurationMs: 60_000 },
        nodes: [
          workflowNode('manual', 'core.manual'),
          workflowNode('switch', 'core.switch', {
            position: { x: 10, y: 0 },
            config: { cases: [{ id: 'case-01', equals: true }] },
            inputMappings: { value: { kind: 'literal', value: true } },
          }),
          workflowNode('terminate', 'core.terminate', {
            position: { x: 20, y: 0 },
          }),
        ],
        edges: [
          {
            id: 'manual-switch',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'switch', port: 'in' },
          },
          {
            id: 'switch-terminate',
            source: { nodeId: 'switch', port: 'case-01' },
            target: { nodeId: 'terminate', port: 'in' },
          },
        ],
      },
    });
    const checkpoint = createInitialCheckpoint(
      {
        id: workflowVersionId,
        workspaceId,
        workflowId,
        versionNumber: 1,
        checksum: compiled.checksum,
        executableJson: compiled.envelope,
      },
      {
        catalog,
      },
    );

    expectInitialCheckpoint(checkpoint);
    expect(parseCheckpoint(checkpoint.checkpoint)).toMatchObject({
      branchSelections: [],
    });
  });

  it('initializes the checkpoint for a verified For Each executable', () => {
    const { compiled, catalog } = forEachExecutable();
    const checkpoint = createInitialCheckpoint(
      {
        id: workflowVersionId,
        workspaceId,
        workflowId,
        versionNumber: 1,
        checksum: compiled.checksum,
        executableJson: compiled.envelope,
      },
      {
        catalog,
      },
    );

    expectInitialCheckpoint(checkpoint);
    expect(parseCheckpoint(checkpoint.checkpoint)).toMatchObject({
      branchSelections: [],
    });
  });

  it('initializes the checkpoint for a verified Parallel executable', () => {
    const { compiled, catalog } = parallelExecutable();
    const checkpoint = createInitialCheckpoint(
      {
        ...projection(compiled),
      },
      {
        catalog,
      },
    );

    expectInitialCheckpoint(checkpoint);
    expect(parseCheckpoint(checkpoint.checkpoint)).toMatchObject({
      branchSelections: [],
    });
  });

  it('initializes the checkpoint for a verified root executable', () => {
    const compiled = executable();
    const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
    const checkpoint = createInitialCheckpoint(
      {
        ...projection(compiled),
      },
      {
        catalog,
      },
    );

    expectInitialCheckpoint(checkpoint);
  });

  it('rejects an executable whose checksum does not match', () => {
    const compiled = executable();
    const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
    expect(() =>
      createInitialCheckpoint(
        {
          ...projection(compiled),
          checksum: '0'.repeat(64),
        },
        {
          catalog,
        },
      ),
    ).toThrow(WorkflowEngineError);
  });

  it('verifies the executable and creates the initial event-bound checkpoint', async () => {
    const compiled = executable();
    const start = vi.fn<WorkflowRunDatabase['start']>(async (input) => {
      await Promise.resolve();
      const initial = input.checkpointFactory(projection(compiled));
      expect(parseCheckpoint(initial.checkpoint)).toMatchObject({
        workflowVersionId,
        revision: 0,
        nextEventSequence: 2,
        runStatus: 'queued',
      });
      return { run: run(), replayed: false };
    });
    const close = vi.fn<WorkflowRunDatabase['close']>().mockResolvedValue();
    const publish = vi.fn().mockResolvedValue({ receivers: 1 });
    const database = {
      canRead: () => Promise.resolve(true),
      start,
      replay: vi.fn<WorkflowRunDatabase['replay']>(),
      get: vi.fn<WorkflowRunDatabase['get']>().mockResolvedValue(undefined),
      list: vi
        .fn<WorkflowRunDatabase['list']>()
        .mockResolvedValue({ items: [] }),
      statistics: vi.fn<WorkflowRunDatabase['statistics']>(),
      recovery: vi.fn<WorkflowRunDatabase['recovery']>(),
      recover: vi.fn<WorkflowRunDatabase['recover']>(),
      usageTrends: vi.fn<WorkflowRunDatabase['usageTrends']>(),
      usageCapacity: vi.fn<WorkflowRunDatabase['usageCapacity']>(),
      cancel: vi.fn<WorkflowRunDatabase['cancel']>().mockResolvedValue({
        run: run(),
        alreadyRequested: false,
        eventSequence: 2,
      }),
      readVariables: () => Promise.resolve({ revision: 0, values: {} }),
      readInput: vi.fn<WorkflowRunDatabase['readInput']>(),
      readNodeRunDiagnostics: () => Promise.resolve(undefined),
      readNodeRunOutput: vi.fn<WorkflowRunDatabase['readNodeRunOutput']>(),
      readNodeRunInput: vi.fn<WorkflowRunDatabase['readNodeRunInput']>(),
      stepHealth: vi.fn<WorkflowRunDatabase['stepHealth']>(),
      stepRuns: vi.fn<WorkflowRunDatabase['stepRuns']>(),
      close,
    } satisfies WorkflowRunDatabase;
    const adapter = createPostgresWorkflowRunPersistence(
      parseDatabaseConfig({
        connectionString: 'postgresql://unused.invalid/pertexo',
      }),
      database,
      {
        close: vi.fn().mockResolvedValue(undefined),
        publish,
        resync: vi.fn().mockResolvedValue({ receivers: 1 }),
      },
    );

    await expect(
      adapter.persistence.start({
        actorId,
        workspaceId,
        workflowId,
        idempotencyKeyHash: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
        scope: `workflow:${workflowId}:manual`,
      }),
    ).resolves.toMatchObject({ run: { id: runId }, replayed: false });
    await expect(
      adapter.persistence.cancel({ actorId, workspaceId, runId }),
    ).resolves.toMatchObject({ alreadyRequested: false });
    expect(publish.mock.calls).toEqual([
      [{ workspaceId, runId, sequence: 1 }],
      [{ workspaceId, runId, sequence: 2 }],
    ]);
    await adapter.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
