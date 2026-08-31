import type {
  NodeAttemptLease,
  PublishedWorkflowV2Projection,
} from '@pertexo/database/testing';
import {
  CORE_REGISTRY_RELEASE,
  CORE_REGISTRY_RELEASE_SUCCESSOR,
  CORE_REGISTRY_RELEASE_SUPPORT,
} from '@pertexo/nodes-core';
import {
  createCoreNodeRegistry,
  createCoreNodeRegistryForRelease,
} from '@pertexo/nodes-core/server';
import {
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
} from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseSupport,
  invocationKey,
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

function forEachGraph() {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'loop',
        definition: { key: 'core.foreach', version: 1 },
        inputMappings: {
          items: { kind: 'literal' as const, value: ['first', 'second'] },
        },
        structured: {
          kind: 'for_each' as const,
          maxIterations: 2,
          maxConcurrency: 1,
          body: {
            schemaVersion: 1 as const,
            settings: {},
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
            nodes: [
              {
                ...base.nodes[1],
                id: 'body-first',
                definition: { key: 'core.set', version: 1 },
                inputMappings: {
                  value: {
                    kind: 'structured_input' as const,
                    port: 'item' as const,
                    path: '$',
                  },
                },
              },
              {
                ...base.nodes[1],
                id: 'body-sink',
                definition: { key: 'core.set', version: 1 },
                inputMappings: {
                  value: {
                    kind: 'node_output' as const,
                    nodeId: 'body-first',
                    path: '$',
                  },
                },
              },
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
      base.nodes[1],
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
  };
}

function conditionGraph() {
  const base = graph();
  const branchNode = (id: string) => ({
    ...base.nodes[1],
    id,
    definition: { key: 'core.set', version: 1 },
    inputMappings: { value: { kind: 'literal' as const, value: id } },
  });
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...branchNode('condition'),
        definition: { key: 'core.condition', version: 1 },
        inputMappings: {
          condition: { kind: 'literal' as const, value: true },
        },
      },
      branchNode('selected'),
      branchNode('unselected'),
    ],
    edges: [
      {
        id: 'manual-condition',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'condition', port: 'in' },
      },
      {
        id: 'condition-selected',
        source: { nodeId: 'condition', port: 'true' },
        target: { nodeId: 'selected', port: 'in' },
      },
      {
        id: 'condition-unselected',
        source: { nodeId: 'condition', port: 'false' },
        target: { nodeId: 'unselected', port: 'in' },
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
    admissionKind: 'execute',
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

    expect(prepared.upstreamNodeOutputs).toEqual([]);
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

  it('rejects a branch scope without executable ancestry', () => {
    const { release, projection, lease } = fixture('manual');
    const scopedLease: NodeAttemptLease = {
      ...lease,
      invocationKey: `${VERSION_ID}|manual|b:condition%3Atrue|i:`,
      branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
    };
    const engine = createNodeAttemptExecutionEngine({
      admissionRelease: release,
      currentRelease: release,
    });

    expect(() => engine.prepare({ projection, lease: scopedLease })).toThrow(
      'branch scope',
    );
  });

  it('uses the parent scope for the branch node that introduces a selected path', () => {
    const release = composeExecutableCompatibilityRelease(
      PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
    );
    const executable = buildWorkflowExecutableV2({
      graph: conditionGraph(),
      release,
    });
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
    const branchPath = [{ nodeId: 'condition', outputPort: 'true' }] as const;
    const lease: NodeAttemptLease = {
      ...fixture('manual').lease,
      nodeId: 'selected',
      branchPath,
      invocationKey: invocationKey({
        workflowVersionId: VERSION_ID,
        nodeId: 'selected',
        branchPath: ['condition:true'],
      }),
    };

    expect(
      createNodeAttemptExecutionEngine({
        admissionRelease: release,
        currentRelease: release,
      }).prepare({ projection, lease }).upstreamNodeOutputs,
    ).toEqual([
      {
        nodeId: 'condition',
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: 'condition',
        }),
      },
    ]);
  });

  it('derives the exact direct-upstream set and rejects a changed side-effect pin', () => {
    const { release, projection, lease } = fixture('terminate');
    const engine = createNodeAttemptExecutionEngine({
      admissionRelease: release,
      currentRelease: release,
    });

    expect(engine.prepare({ projection, lease }).upstreamNodeOutputs).toEqual([
      { nodeId: 'manual', invocationKey: `${VERSION_ID}|manual|b:|i:` },
    ]);
    expect(() =>
      engine.prepare({
        projection,
        lease: { ...lease, sideEffectClass: 'unsafe' },
      }),
    ).toThrow('side-effect');
  });

  it('executes the prepared target through the production overlap support', async () => {
    const releaseSupport = createExecutableCompatibilityReleaseSupport(
      CORE_REGISTRY_RELEASE_SUPPORT.map(composeExecutableCompatibilityRelease),
    );
    const target = composeExecutableCompatibilityRelease(
      CORE_REGISTRY_RELEASE_SUCCESSOR,
    );
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: target,
    });
    const currentCompatibilityRelease = releaseSupport.descriptions.at(-1);
    if (currentCompatibilityRelease === undefined)
      throw new Error('target release fixture is missing');
    const { lease } = fixture('manual');
    const projection: PublishedWorkflowV2Projection = {
      id: VERSION_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      versionNumber: 1,
      schemaVersion: 1,
      checksum: executable.checksum,
      executableSchemaVersion: 2,
      executableJson: executable.envelope,
      compatibilityReleaseEpoch: target.epoch,
      currentCompatibilityRelease,
    };
    const engine = createNodeAttemptExecutionEngine({
      admissionRelease: composeExecutableCompatibilityRelease(
        CORE_REGISTRY_RELEASE,
      ),
      releaseSupport,
    });
    const prepared = engine.prepare({ projection, lease });

    await expect(
      prepared.execute({
        runInput: { target: true },
        completedNodeOutputs: {},
        abortRequested: false,
        registry: createCoreNodeRegistryForRelease(
          CORE_REGISTRY_RELEASE_SUCCESSOR,
        ),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded', output: { target: true } });
  });

  it('recursively prepares a For Each body node with exact ordinal-scoped upstream identity', async () => {
    const release = composeExecutableCompatibilityRelease(
      PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
    );
    const executable = buildWorkflowExecutableV2({
      graph: forEachGraph(),
      release,
    });
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
    const iterationPath = [{ loopNodeId: 'loop', ordinal: 1 }] as const;
    const bodyInvocationKey = invocationKey({
      workflowVersionId: VERSION_ID,
      nodeId: 'body-sink',
      iterationPath,
    });
    const upstreamInvocationKey = invocationKey({
      workflowVersionId: VERSION_ID,
      nodeId: 'body-first',
      iterationPath,
    });
    const lease: NodeAttemptLease = {
      ...fixture('manual').lease,
      nodeId: 'body-sink',
      invocationKey: bodyInvocationKey,
      iterationPath,
    };
    const prepared = createNodeAttemptExecutionEngine({
      admissionRelease: release,
      currentRelease: release,
    }).prepare({ projection, lease });

    expect(prepared.upstreamNodeOutputs).toEqual([
      { nodeId: 'body-first', invocationKey: upstreamInvocationKey },
    ]);
    await expect(
      prepared.execute({
        runInput: {},
        completedNodeOutputs: [
          {
            nodeId: 'body-first',
            invocationKey: upstreamInvocationKey,
            value: { value: 'second' },
          },
        ],
        structuredCollection: {
          loopNodeId: 'loop',
          ordinal: 1,
          collection: ['first', 'second'],
          collectionSize: 2,
          declaredCollectionChecksum:
            'f5ca319099f6b777b72517eb1fd6c40d5fd45f43acd86c0ce687aed7b8a7a0f9',
        },
        abortRequested: false,
        registry: createPlatformNodeRegistryForRelease(
          PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
        ),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ nodeId: 'body-sink', kind: 'succeeded' });
  });

  it('rejects body preparation outside its exact iteration ancestry', () => {
    const release = composeExecutableCompatibilityRelease(
      PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
    );
    const executable = buildWorkflowExecutableV2({
      graph: forEachGraph(),
      release,
    });
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

    expect(() =>
      createNodeAttemptExecutionEngine({
        admissionRelease: release,
        currentRelease: release,
      }).prepare({
        projection,
        lease: {
          ...fixture('manual').lease,
          nodeId: 'body-first',
          invocationKey: invocationKey({
            workflowVersionId: VERSION_ID,
            nodeId: 'body-first',
          }),
        },
      }),
    ).toThrow('structured scope');
  });
});
