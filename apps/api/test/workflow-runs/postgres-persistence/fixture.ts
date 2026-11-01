import { parseCheckpoint } from '@pertexo/workflow-engine';

import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import { expect, vi } from 'vitest';
import type { createInitialCheckpoint } from '@pertexo/core/execution';
import type { createPostgresWorkflowRunPersistence } from '../../../src/workflow-runs/postgres-persistence.js';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import type { WorkflowRunDatabase } from '@pertexo/core/testing';
import type { executable } from './graphs.js';

export { executable, forEachExecutable, parallelExecutable } from './graphs.js';
export const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workflowVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const actorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

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
