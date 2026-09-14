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
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
} from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseSupport,
  invocationKey,
} from '@pertexo/workflow-engine';
import { describe, expect, it, vi } from 'vitest';

import { createNodeAttemptExecutionEngine } from '../src/execution/node-attempt-engine.js';

const NODE_RUN_ID = '55555555-5555-4555-8555-555555555555';
const ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';
const OUTBOX_ID = '77777777-7777-4777-8777-777777777777';

import {
  RUN_ID,
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from './support/execution-engine.fixture.js';

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
      {
        ...base.nodes[1],
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'loop',
            path: '$',
          },
        },
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
  };
}

function branchGraph(kind: 'condition' | 'switch') {
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
        ...branchNode(kind),
        definition: { key: `core.${kind}`, version: 1 },
        config:
          kind === 'condition'
            ? {}
            : { cases: [{ id: 'case-01', equals: 'selected' }] },
        inputMappings:
          kind === 'condition'
            ? { condition: { kind: 'literal' as const, value: true } }
            : { value: { kind: 'literal' as const, value: 'selected' } },
      },
      branchNode('selected'),
      branchNode('unselected'),
    ],
    edges: [
      {
        id: `manual-${kind}`,
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: kind, port: 'in' },
      },
      {
        id: `${kind}-selected`,
        source: {
          nodeId: kind,
          port: kind === 'condition' ? 'true' : 'case-01',
        },
        target: { nodeId: 'selected', port: 'in' },
      },
      {
        id: `${kind}-unselected`,
        source: {
          nodeId: kind,
          port: kind === 'condition' ? 'false' : 'default',
        },
        target: { nodeId: 'unselected', port: 'in' },
      },
    ],
  };
}

function parallelMergeGraph() {
  const base = graph();
  const setNode = (id: string) => ({
    ...base.nodes[1],
    id,
    definition: { key: 'core.set', version: 1 },
    inputMappings: {
      value: { kind: 'literal' as const, value: id },
    },
  });
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...setNode('parallel'),
        definition: { key: 'core.parallel', version: 1 },
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        inputMappings: {},
      },
      setNode('left'),
      setNode('right'),
      {
        ...setNode('merge'),
        definition: { key: 'core.merge', version: 1 },
        config: {
          parallelNodeId: 'parallel',
          policy: { kind: 'all' as const },
        },
        inputMappings: {},
      },
      {
        ...base.nodes[1],
        id: 'terminate',
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'merge',
            path: '$',
          },
        },
      },
    ],
    edges: (
      [
        ['manual-parallel', 'manual', 'out', 'parallel', 'in'],
        ['parallel-left', 'parallel', 'branch-01', 'left', 'in'],
        ['parallel-right', 'parallel', 'branch-02', 'right', 'in'],
        ['left-merge', 'left', 'out', 'merge', 'branch-01'],
        ['right-merge', 'right', 'out', 'merge', 'branch-02'],
        ['merge-terminate', 'merge', 'out', 'terminate', 'in'],
      ] as const
    ).map(([id, sourceNodeId, sourcePort, targetNodeId, targetPort]) => ({
      id,
      source: { nodeId: sourceNodeId, port: sourcePort },
      target: { nodeId: targetNodeId, port: targetPort },
    })),
  };
}

function nestedBranchGraph() {
  const base = graph();
  const setNode = (id: string) => ({
    ...base.nodes[1],
    id,
    definition: { key: 'core.set', version: 1 },
    inputMappings: {
      value: { kind: 'literal' as const, value: id },
    },
  });
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...setNode('condition'),
        definition: { key: 'core.condition', version: 1 },
        inputMappings: {
          condition: { kind: 'literal' as const, value: true },
        },
      },
      {
        ...setNode('switch'),
        definition: { key: 'core.switch', version: 1 },
        config: { cases: [{ id: 'case-01', equals: 'selected' }] },
        inputMappings: {
          value: { kind: 'literal' as const, value: 'selected' },
        },
      },
      setNode('selected'),
      setNode('condition-other'),
      setNode('switch-other'),
    ],
    edges: (
      [
        ['manual-condition', 'manual', 'out', 'condition', 'in'],
        ['condition-switch', 'condition', 'true', 'switch', 'in'],
        ['condition-other', 'condition', 'false', 'condition-other', 'in'],
        ['switch-selected', 'switch', 'case-01', 'selected', 'in'],
        ['switch-other', 'switch', 'default', 'switch-other', 'in'],
      ] as const
    ).map(([id, sourceNodeId, sourcePort, targetNodeId, targetPort]) => ({
      id,
      source: { nodeId: sourceNodeId, port: sourcePort },
      target: { nodeId: targetNodeId, port: targetPort },
    })),
  };
}

function compiledProjection(
  workflowGraph: Parameters<typeof buildWorkflowExecutableV2>[0]['graph'],
  release: ReturnType<typeof composeExecutableCompatibilityRelease>,
): PublishedWorkflowV2Projection {
  const executable = buildWorkflowExecutableV2({
    graph: workflowGraph,
    release,
  });
  return {
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
      graph: branchGraph('condition'),
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

  it('rejects projection drift, a missing node, and a forged invocation pin independently', () => {
    const { release, projection, lease } = fixture('manual');
    const engine = createNodeAttemptExecutionEngine({
      admissionRelease: release,
      currentRelease: release,
    });

    expect(() =>
      engine.prepare({
        projection: { ...projection, id: ATTEMPT_ID },
        lease,
      }),
    ).toThrow('workflow version identity');
    expect(() =>
      engine.prepare({
        projection,
        lease: {
          ...lease,
          nodeId: 'missing',
          invocationKey: invocationKey({
            workflowVersionId: VERSION_ID,
            nodeId: 'missing',
          }),
        },
      }),
    ).toThrow('not in workflow');
    expect(() =>
      engine.prepare({
        projection,
        lease: { ...lease, invocationKey: `${lease.invocationKey}-forged` },
      }),
    ).toThrow('invocation scope');
  });

  it.each([
    ['condition', PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE, 'true', 'false'],
    ['switch', PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE, 'case-01', 'default'],
  ] as const)(
    'requires the exact %s branch path without omissions or duplicates',
    (kind, registryRelease, selectedPort, wrongPort) => {
      const release = composeExecutableCompatibilityRelease(registryRelease);
      const projection = compiledProjection(branchGraph(kind), release);
      const engine = createNodeAttemptExecutionEngine({
        admissionRelease: release,
        currentRelease: release,
      });
      const selectedPath = [
        { nodeId: kind, outputPort: selectedPort },
      ] as const;
      const selectedLease: NodeAttemptLease = {
        ...fixture('manual').lease,
        nodeId: 'selected',
        branchPath: selectedPath,
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: 'selected',
          branchPath: [`${kind}:${selectedPort}`],
        }),
      };
      expect(
        engine.prepare({ projection, lease: selectedLease })
          .upstreamNodeOutputs,
      ).toEqual([
        {
          nodeId: kind,
          invocationKey: invocationKey({
            workflowVersionId: VERSION_ID,
            nodeId: kind,
          }),
        },
      ]);
      for (const branchPath of [
        [],
        [{ nodeId: kind, outputPort: wrongPort }],
        [...selectedPath, ...selectedPath],
      ])
        expect(() =>
          engine.prepare({
            projection,
            lease: {
              ...selectedLease,
              branchPath,
              invocationKey: invocationKey({
                workflowVersionId: VERSION_ID,
                nodeId: 'selected',
                branchPath: branchPath.map(
                  ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
                ),
              }),
            },
          }),
        ).toThrow('branch scope');
    },
  );

  it('preserves ordered nested branch ancestry and only removes the introducing source scope', () => {
    const release = composeExecutableCompatibilityRelease(
      PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
    );
    const projection = compiledProjection(nestedBranchGraph(), release);
    const engine = createNodeAttemptExecutionEngine({
      admissionRelease: release,
      currentRelease: release,
    });
    const branchPath = [
      { nodeId: 'condition', outputPort: 'true' },
      { nodeId: 'switch', outputPort: 'case-01' },
    ] as const;
    const selectedLease: NodeAttemptLease = {
      ...fixture('manual').lease,
      nodeId: 'selected',
      branchPath,
      invocationKey: invocationKey({
        workflowVersionId: VERSION_ID,
        nodeId: 'selected',
        branchPath: ['condition:true', 'switch:case-01'],
      }),
    };

    expect(
      engine.prepare({ projection, lease: selectedLease }).upstreamNodeOutputs,
    ).toEqual([
      {
        nodeId: 'switch',
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: 'switch',
          branchPath: ['condition:true'],
        }),
      },
    ]);
    for (const invalidPath of [branchPath.slice(1), [...branchPath].reverse()])
      expect(() =>
        engine.prepare({
          projection,
          lease: {
            ...selectedLease,
            branchPath: invalidPath,
            invocationKey: invocationKey({
              workflowVersionId: VERSION_ID,
              nodeId: 'selected',
              branchPath: invalidPath.map(
                ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
              ),
            }),
          },
        }),
      ).toThrow('branch scope');
  });

  it('pins Parallel branches while treating Merge and its downstream as unbranched', () => {
    const release = composeExecutableCompatibilityRelease(
      PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
    );
    const projection = compiledProjection(parallelMergeGraph(), release);
    const engine = createNodeAttemptExecutionEngine({
      admissionRelease: release,
      currentRelease: release,
    });
    const baseLease = fixture('manual').lease;
    const leftPath = [{ nodeId: 'parallel', outputPort: 'branch-01' }] as const;
    const left = engine.prepare({
      projection,
      lease: {
        ...baseLease,
        nodeId: 'left',
        branchPath: leftPath,
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: 'left',
          branchPath: ['parallel:branch-01'],
        }),
      },
    });
    expect(left.upstreamNodeOutputs).toEqual([
      {
        nodeId: 'parallel',
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: 'parallel',
        }),
      },
    ]);

    for (const [nodeId, upstreamNodeId] of [
      ['merge', undefined],
      ['terminate', 'merge'],
    ] as const) {
      const prepared = engine.prepare({
        projection,
        lease: {
          ...baseLease,
          nodeId,
          invocationKey: invocationKey({
            workflowVersionId: VERSION_ID,
            nodeId,
          }),
        },
      });
      expect(prepared.upstreamNodeOutputs).toEqual(
        upstreamNodeId === undefined
          ? []
          : [
              {
                nodeId: upstreamNodeId,
                invocationKey: invocationKey({
                  workflowVersionId: VERSION_ID,
                  nodeId: upstreamNodeId,
                }),
              },
            ],
      );
    }
  });

  it('rejects an already-aborted prepared execution before registry dispatch', async () => {
    const { release, projection, lease } = fixture('manual');
    const prepared = createNodeAttemptExecutionEngine({
      admissionRelease: release,
      currentRelease: release,
    }).prepare({ projection, lease });
    const execute = vi.fn();

    await expect(
      prepared.execute({
        abortRequested: true,
        completedNodeOutputs: {},
        registry: { execute },
        runInput: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
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

    const engine = createNodeAttemptExecutionEngine({
      admissionRelease: release,
      currentRelease: release,
    });
    for (const iterationPath of [
      undefined,
      [{ loopNodeId: 'wrong-loop', ordinal: 1 }],
      [
        { loopNodeId: 'loop', ordinal: 1 },
        { loopNodeId: 'extra-loop', ordinal: 0 },
      ],
    ] as const)
      expect(() =>
        engine.prepare({
          projection,
          lease: {
            ...fixture('manual').lease,
            nodeId: 'body-first',
            invocationKey: invocationKey({
              workflowVersionId: VERSION_ID,
              nodeId: 'body-first',
              ...(iterationPath === undefined ? {} : { iterationPath }),
            }),
            ...(iterationPath === undefined ? {} : { iterationPath }),
          },
        }),
      ).toThrow('structured scope');
  });
});
