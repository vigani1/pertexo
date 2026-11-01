import { workflowNode } from '../../support/workflow-node.js';
import { problemResult } from '../../support/problem.js';
import { runFailure } from '../../../src/problems/context/normalize.js';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  parseCheckpoint,
} from '@pertexo/workflow-engine';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

import { expect, it, vi } from 'vitest';

import { createInitialCheckpoint } from '@pertexo/core/execution';
import { createPostgresWorkflowRunPersistence } from '../../../src/workflow-runs/postgres-persistence.js';

import {
  WorkflowRunNotFoundError as DatabaseWorkflowRunNotFoundError,
  type WorkflowRunDatabase,
} from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  workspaceId,
  workflowId,
  workflowVersionId,
  runId,
  actorId,
  expectInitialCheckpoint,
  run,
  databaseWith,
  adapterConfig,
  invokePersistence,
} from './fixture.js';

export function registerDoesNotTurnCommittedAcceptanceCancellation(): void {
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
}
