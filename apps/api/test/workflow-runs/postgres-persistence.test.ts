import {
  CORE_REGISTRY_RELEASE,
  CORE_REGISTRY_RELEASE_SUCCESSOR,
} from '@pertexo/nodes-core';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  describeExecutableCompatibilityRelease,
  parseCheckpoint,
  createExecutableCompatibilityReleaseHistory,
} from '@pertexo/workflow-engine';
import {
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
} from '@pertexo/node-catalog';
import { describe, expect, it, vi } from 'vitest';

import {
  PHASE3_API_ENGINE_VERSION,
  createInitialWorkflowCheckpoint,
  createPostgresWorkflowRunPersistence,
} from '../../src/workflow-runs/postgres-persistence.js';
import {
  RegionalWriteAdmissionPausedError,
  parseDatabaseConfig,
  type WorkflowRunDatabase,
} from '@pertexo/database/testing';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function executable(nodeRelease: unknown = CORE_REGISTRY_RELEASE) {
  const release = composeExecutableCompatibilityRelease(nodeRelease);
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
  it('maps a regional write fence to a retryable service response', async () => {
    const database = {
      start: vi
        .fn<WorkflowRunDatabase['start']>()
        .mockRejectedValue(new RegionalWriteAdmissionPausedError()),
      get: vi.fn<WorkflowRunDatabase['get']>().mockResolvedValue(undefined),
      cancel: vi.fn<WorkflowRunDatabase['cancel']>(),
      close: vi.fn<WorkflowRunDatabase['close']>().mockResolvedValue(),
    } satisfies WorkflowRunDatabase;
    const adapter = createPostgresWorkflowRunPersistence(
      parseDatabaseConfig({
        connectionString: 'postgresql://unused.invalid/pertexo',
      }),
      database,
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
    ).rejects.toMatchObject({
      code: 'platform.write_paused',
      details: { retryAfterSeconds: 5 },
    });
  });

  it('initializes checkpoint V2 for a verified Condition executable', () => {
    const release = composeExecutableCompatibilityRelease(
      PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
    );
    const compiled = buildWorkflowExecutableV2({
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
    const checkpoint = createInitialWorkflowCheckpoint(
      {
        id: workflowVersionId,
        workspaceId,
        workflowId,
        versionNumber: 1,
        schemaVersion: 1,
        checksum: compiled.checksum,
        executableSchemaVersion: 2,
        executableJson: compiled.envelope,
        compatibilityReleaseEpoch: release.epoch,
      },
      createExecutableCompatibilityReleaseHistory([release]),
      describeExecutableCompatibilityRelease(release),
    );

    expect(parseCheckpoint(checkpoint.checkpoint)).toMatchObject({
      schemaVersion: 2,
      branchSelections: [],
    });
  });

  it('initializes checkpoint V2 for a verified Switch executable', () => {
    const release = composeExecutableCompatibilityRelease(
      PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
    );
    const compiled = buildWorkflowExecutableV2({
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
    const checkpoint = createInitialWorkflowCheckpoint(
      {
        id: workflowVersionId,
        workspaceId,
        workflowId,
        versionNumber: 1,
        schemaVersion: 1,
        checksum: compiled.checksum,
        executableSchemaVersion: 2,
        executableJson: compiled.envelope,
        compatibilityReleaseEpoch: release.epoch,
      },
      createExecutableCompatibilityReleaseHistory([release]),
      describeExecutableCompatibilityRelease(release),
    );

    expect(parseCheckpoint(checkpoint.checkpoint)).toMatchObject({
      schemaVersion: 2,
      branchSelections: [],
    });
  });

  it('verifies the exact V2 release and creates the initial event-bound checkpoint', async () => {
    const compiled = executable();
    const targetCompiled = executable(CORE_REGISTRY_RELEASE_SUCCESSOR);
    expect(
      describeExecutableCompatibilityRelease(
        composeExecutableCompatibilityRelease(CORE_REGISTRY_RELEASE),
      ).fingerprint,
    ).toBe(
      'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
    );
    const start = vi.fn<WorkflowRunDatabase['start']>(async (input) => {
      await Promise.resolve();
      for (const [nodeRelease, executableVersion] of [
        [CORE_REGISTRY_RELEASE, compiled],
        [CORE_REGISTRY_RELEASE_SUCCESSOR, targetCompiled],
      ] as const) {
        const initial = input.checkpointFactory(
          {
            id: workflowVersionId,
            workspaceId,
            workflowId,
            versionNumber: 1,
            schemaVersion: 1,
            checksum: executableVersion.checksum,
            executableSchemaVersion: 2,
            executableJson: executableVersion.envelope,
            compatibilityReleaseEpoch:
              executableVersion.envelope.compatibilityReleaseEpoch,
          },
          describeExecutableCompatibilityRelease(
            composeExecutableCompatibilityRelease(nodeRelease),
          ),
        );
        expect(initial.engineVersion).toBe(PHASE3_API_ENGINE_VERSION);
        expect(parseCheckpoint(initial.checkpoint)).toMatchObject({
          schemaVersion: 1,
          workflowVersionId,
          engineVersion: PHASE3_API_ENGINE_VERSION,
          revision: 0,
          nextEventSequence: 2,
          runStatus: 'queued',
        });
      }
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
