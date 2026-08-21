import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  describeExecutableCompatibilityRelease,
  parseCheckpoint,
} from '@pertexo/workflow-engine';
import { describe, expect, it, vi } from 'vitest';

import {
  PHASE3_API_ENGINE_VERSION,
  createPostgresWorkflowRunPersistence,
} from '../../src/workflow-runs/postgres-persistence.js';
import {
  parseDatabaseConfig,
  type WorkflowRunDatabase,
} from '@pertexo/database';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function executable() {
  const release = composeExecutableCompatibilityRelease(CORE_REGISTRY_RELEASE);
  return buildWorkflowExecutableV2({
    release,
    graph: {
      schemaVersion: 1,
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

describe('PostgreSQL workflow run persistence adapter', () => {
  it('verifies the exact V2 release and creates the initial event-bound checkpoint', async () => {
    const compiled = executable();
    expect(
      describeExecutableCompatibilityRelease(
        composeExecutableCompatibilityRelease(CORE_REGISTRY_RELEASE),
      ).fingerprint,
    ).toBe(
      'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
    );
    const start = vi.fn<WorkflowRunDatabase['start']>(async (input) => {
      await Promise.resolve();
      const initial = input.checkpointFactory({
        id: workflowVersionId,
        workspaceId,
        workflowId,
        versionNumber: 1,
        schemaVersion: 1,
        checksum: compiled.checksum,
        executableSchemaVersion: 2,
        executableJson: compiled.envelope,
        compatibilityReleaseEpoch: compiled.envelope.compatibilityReleaseEpoch,
      });
      expect(initial.engineVersion).toBe(PHASE3_API_ENGINE_VERSION);
      expect(parseCheckpoint(initial.checkpoint)).toMatchObject({
        workflowVersionId,
        engineVersion: PHASE3_API_ENGINE_VERSION,
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
      get: vi.fn<WorkflowRunDatabase['get']>().mockResolvedValue(undefined),
      cancel: vi.fn<WorkflowRunDatabase['cancel']>().mockResolvedValue({
        run: run(),
        alreadyRequested: false,
        eventSequence: 2,
      }),
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
