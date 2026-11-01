import { workflowNode } from '../../support/workflow-node.js';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  parseCheckpoint,
  WorkflowEngineError,
} from '@pertexo/workflow-engine';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

import { expect, it, vi } from 'vitest';

import { createInitialCheckpoint } from '@pertexo/core/execution';
import { createPostgresWorkflowRunPersistence } from '../../../src/workflow-runs/postgres-persistence.js';

import { parseDatabaseConfig } from '@pertexo/database/testing';
import type { WorkflowRunDatabase } from '@pertexo/core/testing';
import {
  workspaceId,
  workflowId,
  workflowVersionId,
  runId,
  actorId,
  executable,
  forEachExecutable,
  parallelExecutable,
  projection,
  expectInitialCheckpoint,
  run,
} from './fixture.js';

export function registerInitializesCheckpointVerifiedSwitchExecutable(): void {
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
}
