import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  parseCheckpoint,
} from '@pertexo/workflow-engine';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import { expect, vi } from 'vitest';

import type { createInitialCheckpoint } from '@pertexo/execution';
import type { createPostgresWorkflowRunPersistence } from '../../../src/workflow-runs/postgres-persistence.js';

import {
  parseDatabaseConfig,
  type WorkflowRunDatabase,
} from '@pertexo/database/testing';

export const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workflowVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const actorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export function executable() {
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

export function forEachExecutable() {
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

export function parallelExecutable() {
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

export function projection(compiled: ReturnType<typeof executable>) {
  return {
    id: workflowVersionId,
    workspaceId,
    workflowId,
    versionNumber: 1,
    checksum: compiled.checksum,
    executableJson: compiled.envelope,
  };
}

export function expectInitialCheckpoint(
  checkpoint: ReturnType<typeof createInitialCheckpoint>,
): void {
  expect(parseCheckpoint(checkpoint.checkpoint)).toMatchObject({
    workflowVersionId,
    revision: 0,
    nextEventSequence: 2,
    remainingIterationBudget: WORKFLOW_GRAPH_LIMITS.maxTotalLoopIterations,
  });
}

export function run() {
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

export function statisticsRecord() {
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

export function databaseWith(overrides: Partial<WorkflowRunDatabase> = {}) {
  return {
    canRead: () => Promise.resolve(true),
    recovery: vi.fn<NonNullable<WorkflowRunDatabase['recovery']>>(),
    recover: vi.fn<NonNullable<WorkflowRunDatabase['recover']>>(),
    usageTrends: vi.fn<NonNullable<WorkflowRunDatabase['usageTrends']>>(),
    usageCapacity: vi.fn<NonNullable<WorkflowRunDatabase['usageCapacity']>>(),
    start: vi
      .fn<NonNullable<WorkflowRunDatabase['start']>>()
      .mockResolvedValue({
        run: run(),
        replayed: false,
      }),
    replay: vi
      .fn<NonNullable<WorkflowRunDatabase['replay']>>()
      .mockResolvedValue({
        run: { ...run(), triggerType: 'replay' },
        replayed: false,
      }),
    get: vi.fn<NonNullable<WorkflowRunDatabase['get']>>().mockResolvedValue({
      run: { ...run(), replaySourceRunId: null },
      nodes: [],
    }),
    list: vi.fn<NonNullable<WorkflowRunDatabase['list']>>().mockResolvedValue({
      items: [{ ...run(), replaySourceRunId: null, failedStep: null }],
    }),
    readVariables: () => Promise.resolve({ revision: 0, values: {} }),
    readInput: vi
      .fn<WorkflowRunDatabase['readInput']>()
      .mockResolvedValue({ kind: 'inline', value: { rows: 42 } }),
    readNodeRunDiagnostics: () => Promise.resolve(undefined),
    readNodeRunOutput: vi
      .fn<WorkflowRunDatabase['readNodeRunOutput']>()
      .mockResolvedValue({ kind: 'none' }),
    readNodeRunInput: vi
      .fn<WorkflowRunDatabase['readNodeRunInput']>()
      .mockResolvedValue({ kind: 'none' }),
    stepHealth: vi
      .fn<WorkflowRunDatabase['stepHealth']>()
      .mockResolvedValue({ runsConsidered: 0, oldestRunAt: null, items: [] }),
    stepRuns: vi
      .fn<NonNullable<WorkflowRunDatabase['stepRuns']>>()
      .mockResolvedValue([]),
    statistics: vi
      .fn<WorkflowRunDatabase['statistics']>()
      .mockResolvedValue(statisticsRecord()),
    cancel: vi
      .fn<NonNullable<WorkflowRunDatabase['cancel']>>()
      .mockResolvedValue({
        run: run(),
        alreadyRequested: false,
        eventSequence: 2,
      }),
    close: vi
      .fn<NonNullable<WorkflowRunDatabase['close']>>()
      .mockResolvedValue(),
    ...overrides,
  } satisfies WorkflowRunDatabase;
}

export const adapterConfig = parseDatabaseConfig({
  connectionString: 'postgresql://unused.invalid/pertexo',
});

export async function invokePersistence(
  adapter: ReturnType<typeof createPostgresWorkflowRunPersistence>,
  operation: 'start' | 'replay' | 'get' | 'cancel' | 'statistics',
): Promise<unknown> {
  if (operation === 'statistics')
    return adapter.persistence.statistics({
      actorId,
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
    return adapter.persistence.get({ actorId, workspaceId, runId });
  return adapter.persistence.cancel({ actorId, workspaceId, runId });
}
