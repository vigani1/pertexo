import type {
  NodeAttemptLease,
  PublishedWorkflowV2Projection,
} from '@pertexo/database';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';

import { createNodeAttemptExecutionEngine } from '../src/execution/node-attempt-engine.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const WORKFLOW_ID = '44444444-4444-4444-8444-444444444444';
const NODE_RUN_ID = '55555555-5555-4555-8555-555555555555';
const ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';
const OUTBOX_ID = '77777777-7777-4777-8777-777777777777';

function graph() {
  return {
    schemaVersion: 1 as const,
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
          result: {
            kind: 'node_output' as const,
            nodeId: 'manual',
            path: '$',
          },
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
  };
}

function fixture(nodeId: 'manual' | 'terminate') {
  const release = composeExecutableCompatibilityRelease(CORE_REGISTRY_RELEASE);
  const executable = buildWorkflowExecutableV2({ graph: graph(), release });
  const projection: PublishedWorkflowV2Projection = {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    schemaVersion: 1,
    checksum: executable.checksum,
    executableSchemaVersion: 2,
    executableJson: executable.envelope,
    compatibilityReleaseEpoch: release.epoch,
  };
  const lease: NodeAttemptLease = {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workflowVersionId: VERSION_ID,
    nodeRunId: NODE_RUN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    invocationKey: `${VERSION_ID}|${nodeId}|b:|i:`,
    nodeId,
    sideEffectClass: 'safe',
    workerId: 'worker-1',
    fenceToken: 1,
    leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
    delivery: { outboxEventId: OUTBOX_ID, payloadChecksum: 'a'.repeat(64) },
  };
  return { release, projection, lease };
}

describe('node attempt execution engine', () => {
  it('verifies the pinned executable and executes Manual using only run input', async () => {
    const { release, projection, lease } = fixture('manual');
    const engine = createNodeAttemptExecutionEngine({
      admissionRelease: release,
      currentRelease: release,
    });
    const prepared = engine.prepare({ projection, lease });

    expect(prepared.upstreamNodeIds).toEqual([]);
    await expect(
      prepared.execute({
        runInput: { hello: 'world' },
        completedNodeOutputs: {},
        abortRequested: false,
        registry: createCoreNodeRegistry(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      nodeId: 'manual',
      kind: 'succeeded',
      output: { hello: 'world' },
    });
  });

  it('derives the exact direct-upstream set and rejects a changed side-effect pin', () => {
    const { release, projection, lease } = fixture('terminate');
    const engine = createNodeAttemptExecutionEngine({
      admissionRelease: release,
      currentRelease: release,
    });

    expect(engine.prepare({ projection, lease }).upstreamNodeIds).toEqual([
      'manual',
    ]);
    expect(() =>
      engine.prepare({
        projection,
        lease: { ...lease, sideEffectClass: 'unsafe' },
      }),
    ).toThrow('side-effect');
  });
});
