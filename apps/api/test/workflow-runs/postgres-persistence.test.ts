import { describe, expect, it, vi } from 'vitest';
import { createInitialCheckpoint } from '@pertexo/core/runs';
import { createPostgresWorkflowRunPersistence } from '../../src/workflow-runs/postgres-persistence.js';
import type { WorkflowRunDatabase } from '@pertexo/core/testing';
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

/**
 * Run refusals are asserted over HTTP in http/run-commands.integration.test.ts
 * and workspaces/real-api.integration.test.ts, and the race-only ones in
 * run-problems.test.ts. What stays is the Redis wake-up hint, which only a
 * subscriber or a Redis outage can observe, and the pure initial checkpoint.
 */
describe('PostgreSQL workflow run persistence adapter', () => {
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
    const database = databaseWith({ start, close });
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
