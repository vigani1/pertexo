import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  parseCheckpoint,
  WorkflowEngineError,
} from '@pertexo/workflow-engine';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowPublishedVersionConflictError } from '@pertexo/database/runs';

import { createInitialCheckpoint } from '@pertexo/execution';
import { createPostgresWorkflowRunPersistence } from '../../src/workflow-runs/postgres-persistence.js';
import { usageCapacitySnapshot } from './usage/capacity.fixture.js';
import {
  WorkflowRunIdempotencyConflictError,
  WorkflowRunNotCancelableError,
  WorkflowRunNotExecutableError,
} from '../../src/workflow-runs/errors.js';
import { WorkflowRunNotFoundError } from '../../src/workflow-runs/use-cases.js';
import {
  ExecutionStateConflictError,
  IdempotencyRequestConflictError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
  WorkspaceAccessDeniedError,
  WorkflowRunNotExecutableError as DatabaseWorkflowRunNotExecutableError,
  WorkflowRunNotFoundError as DatabaseWorkflowRunNotFoundError,
  parseDatabaseConfig,
  type WorkflowRunDatabase,
} from '@pertexo/database/testing';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function executable() {
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  return buildWorkflowExecutable({
    catalog,
    graph: {
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        {
          id: 'manual',
          definition: { key: 'core.manual', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
        {
          id: 'terminate',
          definition: { key: 'core.terminate', version: 1 },
          position: { x: 10, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {
            result: { kind: 'node_output', nodeId: 'manual', path: '$' },
          },
          connectionRefs: {},
        },
      ],
      edges: [
        {
          id: 'manual-terminate',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'terminate', port: 'in' },
        },
      ],
    },
  });
}

function forEachExecutable() {
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  const setNode = (id: string, inputMappings: Record<string, unknown>) => ({
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings,
    connectionRefs: {},
  });
  return {
    catalog,
    compiled: buildWorkflowExecutable({
      catalog,
      graph: {
        settings: { maxRunDurationMs: 60_000 },
        nodes: [
          {
            id: 'manual',
            definition: { key: 'core.manual', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
          {
            id: 'loop',
            definition: { key: 'core.foreach', version: 1 },
            position: { x: 10, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: { items: { kind: 'literal', value: [1, 2] } },
            connectionRefs: {},
            structured: {
              kind: 'for_each',
              maxIterations: 2,
              maxConcurrency: 1,
              body: {
                settings: {},
                inputPorts: ['item', 'ordinal'],
                outputPorts: ['result'],
                nodes: [
                  setNode('body-first', {
                    value: {
                      kind: 'structured_input',
                      port: 'item',
                      path: '$',
                    },
                  }),
                  setNode('body-sink', {
                    value: {
                      kind: 'node_output',
                      nodeId: 'body-first',
                      path: '$',
                    },
                  }),
                ],
                edges: [
                  {
                    id: 'body-edge',
                    source: { nodeId: 'body-first', port: 'out' },
                    target: { nodeId: 'body-sink', port: 'in' },
                  },
                ],
              },
            },
          },
          {
            id: 'terminate',
            definition: { key: 'core.terminate', version: 1 },
            position: { x: 20, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {
              result: { kind: 'node_output', nodeId: 'loop', path: '$' },
            },
            connectionRefs: {},
          },
        ],
        edges: [
          {
            id: 'manual-loop',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'loop', port: 'in' },
          },
          {
            id: 'loop-terminate',
            source: { nodeId: 'loop', port: 'out' },
            target: { nodeId: 'terminate', port: 'in' },
          },
        ],
      },
    }),
  };
}

function parallelExecutable() {
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  const ordinaryNode = (id: string) => ({
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 20, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: { value: { kind: 'literal' as const, value: id } },
    connectionRefs: {},
  });
  return {
    catalog,
    compiled: buildWorkflowExecutable({
      catalog,
      graph: {
        settings: { maxRunDurationMs: 60_000 },
        nodes: [
          {
            id: 'manual',
            definition: { key: 'core.manual', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
          {
            id: 'parallel',
            definition: { key: 'core.parallel', version: 1 },
            position: { x: 10, y: 0 },
            configVersion: 1,
            config: {
              branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
              maxConcurrency: 1,
            },
            inputMappings: {},
            connectionRefs: {},
          },
          ordinaryNode('left'),
          ordinaryNode('right'),
          {
            ...ordinaryNode('merge'),
            definition: { key: 'core.merge', version: 1 },
            configVersion: 1,
            config: {
              parallelNodeId: 'parallel',
              policy: { kind: 'all' },
            },
            inputMappings: {},
          },
          {
            id: 'terminate',
            definition: { key: 'core.terminate', version: 1 },
            position: { x: 40, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {
              result: {
                kind: 'node_output',
                nodeId: 'merge',
                path: '$',
              },
            },
            connectionRefs: {},
          },
        ],
        edges: [
          {
            id: 'manual-parallel',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'parallel', port: 'in' },
          },
          {
            id: 'parallel-left',
            source: { nodeId: 'parallel', port: 'branch-01' },
            target: { nodeId: 'left', port: 'in' },
          },
          {
            id: 'parallel-right',
            source: { nodeId: 'parallel', port: 'branch-02' },
            target: { nodeId: 'right', port: 'in' },
          },
          {
            id: 'left-merge',
            source: { nodeId: 'left', port: 'out' },
            target: { nodeId: 'merge', port: 'branch-01' },
          },
          {
            id: 'right-merge',
            source: { nodeId: 'right', port: 'out' },
            target: { nodeId: 'merge', port: 'branch-02' },
          },
          {
            id: 'merge-terminate',
            source: { nodeId: 'merge', port: 'out' },
            target: { nodeId: 'terminate', port: 'in' },
          },
        ],
      },
    }),
  };
}

function projection(compiled: ReturnType<typeof executable>) {
  return {
    id: workflowVersionId,
    workspaceId,
    workflowId,
    versionNumber: 1,
    checksum: compiled.checksum,
    executableJson: compiled.envelope,
  };
}

function expectInitialCheckpoint(
  checkpoint: ReturnType<typeof createInitialCheckpoint>,
): void {
  expect(parseCheckpoint(checkpoint.checkpoint)).toMatchObject({
    workflowVersionId,
    revision: 0,
    nextEventSequence: 2,
    remainingIterationBudget: WORKFLOW_GRAPH_LIMITS.maxTotalLoopIterations,
  });
}

function run() {
  const now = new Date('2026-08-21T12:00:00.000Z');
  return {
    id: runId,
    workspaceId,
    workflowId,
    workflowVersionId,
    status: 'queued' as const,
    triggerType: 'manual' as const,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

function statisticsRecord() {
  const byStatus = {
    queued: 1,
    running: 2,
    waiting: 0,
    succeeded: 5,
    failed: 1,
    canceled: 0,
    timed_out: 0,
    outcome_unknown: 0,
  };
  return {
    asOf: '2026-08-21T12:00:00.000000Z',
    current: { queued: 1, running: 2, waiting: 0 },
    window: {
      duration: '24h' as const,
      createdAtFrom: '2026-08-20T12:00:00.000000Z',
      createdAtBefore: '2026-08-21T12:00:00.000000Z',
      total: 9,
      byStatus,
    },
  };
}

function databaseWith(
  overrides: Partial<WorkflowRunDatabase> = {},
): WorkflowRunDatabase {
  return {
    usageCapacity: vi.fn<WorkflowRunDatabase['usageCapacity']>(),
    start: vi.fn<WorkflowRunDatabase['start']>().mockResolvedValue({
      run: run(),
      replayed: false,
    }),
    replay: vi.fn<WorkflowRunDatabase['replay']>().mockResolvedValue({
      run: { ...run(), triggerType: 'replay' },
      replayed: false,
    }),
    get: vi.fn<WorkflowRunDatabase['get']>().mockResolvedValue({
      run: { ...run(), replaySourceRunId: null },
      nodes: [],
    }),
    list: vi.fn<WorkflowRunDatabase['list']>().mockResolvedValue({
      items: [{ ...run(), replaySourceRunId: null, failedStep: null }],
    }),
    readInput: vi
      .fn<WorkflowRunDatabase['readInput']>()
      .mockResolvedValue({ kind: 'inline', value: { rows: 42 } }),
    readNodeRunOutput: vi
      .fn<WorkflowRunDatabase['readNodeRunOutput']>()
      .mockResolvedValue({ kind: 'none' }),
    readNodeRunInput: vi
      .fn<WorkflowRunDatabase['readNodeRunInput']>()
      .mockResolvedValue({ kind: 'none' }),
    stepHealth: vi
      .fn<WorkflowRunDatabase['stepHealth']>()
      .mockResolvedValue({ runsConsidered: 0, oldestRunAt: null, items: [] }),
    stepRuns: vi.fn<WorkflowRunDatabase['stepRuns']>().mockResolvedValue([]),
    statistics: vi
      .fn<WorkflowRunDatabase['statistics']>()
      .mockResolvedValue(statisticsRecord()),
    cancel: vi.fn<WorkflowRunDatabase['cancel']>().mockResolvedValue({
      run: run(),
      alreadyRequested: false,
      eventSequence: 2,
    }),
    close: vi.fn<WorkflowRunDatabase['close']>().mockResolvedValue(),
    ...overrides,
  };
}

const adapterConfig = parseDatabaseConfig({
  connectionString: 'postgresql://unused.invalid/pertexo',
});

async function invokePersistence(
  adapter: ReturnType<typeof createPostgresWorkflowRunPersistence>,
  operation: 'start' | 'replay' | 'get' | 'cancel' | 'statistics',
): Promise<unknown> {
  if (operation === 'statistics')
    return adapter.persistence.statistics({
      workspaceId,
      window: '24h',
      includeWorkflows: false,
      includeWorkflowName: true,
    });
  if (operation === 'start')
    return adapter.persistence.start({
      actorId,
      workspaceId,
      workflowId,
      idempotencyKeyHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      scope: `workflow:${workflowId}:manual`,
    });
  if (operation === 'replay')
    return adapter.persistence.replay({
      actorId,
      workspaceId,
      sourceRunId: runId,
      workflowVersionId,
      idempotencyKeyHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      scope: `workflow:${runId}:replay`,
      input: null,
    });
  if (operation === 'get')
    return adapter.persistence.get({ workspaceId, runId });
  return adapter.persistence.cancel({ actorId, workspaceId, runId });
}

describe('PostgreSQL workflow run persistence adapter', () => {
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
      adapter.persistence.usageCapacity({ workspaceId }),
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
    await expect(invokePersistence(adapter, 'start')).rejects.toMatchObject({
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
        invokePersistence(adapter, operation),
      ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    },
  );

  it.each(['start', 'replay'] as const)(
    'maps database not-executable and idempotency errors from %s',
    async (operation) => {
      for (const [failure, expected] of [
        [
          new DatabaseWorkflowRunNotExecutableError(),
          WorkflowRunNotExecutableError,
        ],
        [
          new IdempotencyRequestConflictError(),
          WorkflowRunIdempotencyConflictError,
        ],
      ] as const) {
        const database = databaseWith({
          [operation]: vi.fn().mockRejectedValue(failure),
        });
        const adapter = createPostgresWorkflowRunPersistence(
          adapterConfig,
          database,
        );

        await expect(
          invokePersistence(adapter, operation),
        ).rejects.toBeInstanceOf(expected);
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
          invokePersistence(adapter, operation),
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

    await expect(invokePersistence(adapter, 'cancel')).rejects.toBeInstanceOf(
      WorkflowRunNotCancelableError,
    );
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
      readInput,
      readNodeRunOutput: vi
        .fn<WorkflowRunDatabase['readNodeRunOutput']>()
        .mockRejectedValue(new DatabaseWorkflowRunNotFoundError()),
    });
    const adapter = createPostgresWorkflowRunPersistence(
      adapterConfig,
      database,
    );
    await expect(
      adapter.persistence.readInput({ workspaceId, runId }),
    ).resolves.toEqual({ kind: 'inline', value: { rows: 42 } });
    expect(readInput).toHaveBeenCalledWith({ workspaceId, runId });
    await expect(
      adapter.persistence.readNodeRunOutput({
        workspaceId,
        runId,
        nodeRunId: runId,
      }),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
  });

  it('forwards an accepted replay and publishes its durable wake-up hint', async () => {
    const replay = vi.fn<WorkflowRunDatabase['replay']>().mockResolvedValue({
      run: { ...run(), triggerType: 'replay' },
      replayed: false,
    });
    const publish = vi.fn().mockResolvedValue({ receivers: 1 });
    const database = {
      start: vi.fn<WorkflowRunDatabase['start']>(),
      replay,
      get: vi.fn<WorkflowRunDatabase['get']>().mockResolvedValue(undefined),
      list: vi
        .fn<WorkflowRunDatabase['list']>()
        .mockResolvedValue({ items: [] }),
      statistics: vi.fn<WorkflowRunDatabase['statistics']>(),
      usageCapacity: vi.fn<WorkflowRunDatabase['usageCapacity']>(),
      cancel: vi.fn<WorkflowRunDatabase['cancel']>(),
      readInput: vi.fn<WorkflowRunDatabase['readInput']>(),
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
          {
            id: 'manual',
            definition: { key: 'core.manual', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
          {
            id: 'condition',
            definition: { key: 'core.condition', version: 1 },
            position: { x: 10, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {
              condition: { kind: 'literal', value: true },
            },
            connectionRefs: {},
          },
          {
            id: 'terminate',
            definition: { key: 'core.terminate', version: 1 },
            position: { x: 20, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {
              result: {
                kind: 'node_output',
                nodeId: 'condition',
                path: '$',
              },
            },
            connectionRefs: {},
          },
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
          {
            id: 'manual',
            definition: { key: 'core.manual', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
          {
            id: 'switch',
            definition: { key: 'core.switch', version: 1 },
            position: { x: 10, y: 0 },
            configVersion: 1,
            config: { cases: [{ id: 'case-01', equals: true }] },
            inputMappings: { value: { kind: 'literal', value: true } },
            connectionRefs: {},
          },
          {
            id: 'terminate',
            definition: { key: 'core.terminate', version: 1 },
            position: { x: 20, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
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
      start,
      replay: vi.fn<WorkflowRunDatabase['replay']>(),
      get: vi.fn<WorkflowRunDatabase['get']>().mockResolvedValue(undefined),
      list: vi
        .fn<WorkflowRunDatabase['list']>()
        .mockResolvedValue({ items: [] }),
      statistics: vi.fn<WorkflowRunDatabase['statistics']>(),
      usageCapacity: vi.fn<WorkflowRunDatabase['usageCapacity']>(),
      cancel: vi.fn<WorkflowRunDatabase['cancel']>().mockResolvedValue({
        run: run(),
        alreadyRequested: false,
        eventSequence: 2,
      }),
      readInput: vi.fn<WorkflowRunDatabase['readInput']>(),
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
