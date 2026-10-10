import type {
  NodeAttemptLease,
  PublishedWorkflow,
} from '@pertexo/database/testing';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  invocationKey,
} from '@pertexo/workflow-engine';
import { describe, expect, it, vi } from 'vitest';

import { createNodeAttemptExecutionEngine } from '../../src/attempts/engine.js';

const NODE_RUN_ID = '55555555-5555-4555-8555-555555555555';
const ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';
const OUTBOX_ID = '77777777-7777-4777-8777-777777777777';

import {
  RUN_ID,
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from '../support/attempts/execution-engine.js';

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
  workflowGraph: Parameters<typeof buildWorkflowExecutable>[0]['graph'],
  catalog: ReturnType<typeof composeExecutableCatalog>,
): PublishedWorkflow {
  const executable = buildWorkflowExecutable({
    graph: workflowGraph,
    catalog,
  });
  return {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    checksum: executable.checksum,
    executableJson: executable.envelope,
  };
}

function fixture(nodeId: 'manual' | 'terminate') {
  const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
  const executable = buildWorkflowExecutable({ graph: graph(), catalog });
  const projection: PublishedWorkflow = {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    checksum: executable.checksum,
    executableJson: executable.envelope,
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
  return { catalog, projection, lease };
}

describe('node attempt execution engine', () => {
  it('verifies the pinned executable and executes Manual using only run input', async () => {
    const { catalog, projection, lease } = fixture('manual');
    const engine = createNodeAttemptExecutionEngine({
      catalog: catalog,
    });
    const prepared = engine.prepare({ projection, lease });

    expect(prepared.upstreamNodeOutputs).toEqual([]);
    await expect(
      prepared.execute({
        runInput: { hello: 'world' },
        completedNodeOutputs: [],
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

  it('hands the resolved input to be recorded, except for a step that uses a connection', async () => {
    const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
    const run = async (connectionRefs: Readonly<Record<string, string>>) => {
      const base = graph();
      const [manual, ...rest] = base.nodes;
      if (manual === undefined) throw new Error('fixture graph is missing');
      const projection = compiledProjection(
        { ...base, nodes: [{ ...manual, connectionRefs }, ...rest] },
        catalog,
      );
      const engine = createNodeAttemptExecutionEngine({
        catalog: catalog,
      });
      const onInputResolved = vi.fn(() => Promise.resolve());
      await engine
        .prepare({ projection, lease: fixture('manual').lease })
        .execute({
          runInput: { hello: 'world' },
          completedNodeOutputs: [],
          abortRequested: false,
          registry: createCoreNodeRegistry(),
          signal: new AbortController().signal,
          onInputResolved,
        });
      return onInputResolved;
    };

    expect(await run({})).toHaveBeenCalledWith({ hello: 'world' });
    // What a connected step receives is what it sends to a provider.
    expect(
      await run({ provider: '88888888-8888-4888-8888-888888888888' }),
    ).not.toHaveBeenCalled();
  });

  it('derives the exact direct-upstream set', () => {
    const { catalog, projection, lease } = fixture('terminate');
    const engine = createNodeAttemptExecutionEngine({
      catalog: catalog,
    });

    expect(engine.prepare({ projection, lease }).upstreamNodeOutputs).toEqual([
      { nodeId: 'manual', invocationKey: `${VERSION_ID}|manual|b:|i:` },
    ]);
  });

  it('rejects a node that is not in the workflow', () => {
    const { catalog, projection, lease } = fixture('manual');
    const engine = createNodeAttemptExecutionEngine({
      catalog: catalog,
    });

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
  });

  it.each([
    ['condition', 'true'],
    ['switch', 'case-01'],
  ] as const)(
    'reads the %s that introduces a selected path from the parent scope',
    (kind, selectedPort) => {
      const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
      const projection = compiledProjection(branchGraph(kind), catalog);
      const engine = createNodeAttemptExecutionEngine({
        catalog: catalog,
      });
      const selectedLease: NodeAttemptLease = {
        ...fixture('manual').lease,
        nodeId: 'selected',
        branchPath: [{ nodeId: kind, outputPort: selectedPort }],
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
    },
  );

  it('keeps nested branch ancestry and removes only the introducing scope', () => {
    const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
    const projection = compiledProjection(nestedBranchGraph(), catalog);
    const engine = createNodeAttemptExecutionEngine({
      catalog: catalog,
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
  });

  it('pins Parallel branches while treating Merge and its downstream as unbranched', () => {
    const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
    const projection = compiledProjection(parallelMergeGraph(), catalog);
    const engine = createNodeAttemptExecutionEngine({
      catalog: catalog,
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
    const { catalog, projection, lease } = fixture('manual');
    const prepared = createNodeAttemptExecutionEngine({
      catalog: catalog,
    }).prepare({ projection, lease });
    const execute = vi.fn();

    await expect(
      prepared.execute({
        abortRequested: true,
        completedNodeOutputs: [],
        registry: { execute },
        runInput: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes a prepared core-catalog node', async () => {
    const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
    const executable = buildWorkflowExecutable({
      graph: graph(),
      catalog,
    });
    const { lease } = fixture('manual');
    const projection: PublishedWorkflow = {
      id: VERSION_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      versionNumber: 1,
      checksum: executable.checksum,
      executableJson: executable.envelope,
    };
    const engine = createNodeAttemptExecutionEngine({ catalog });
    const prepared = engine.prepare({ projection, lease });

    await expect(
      prepared.execute({
        runInput: { target: true },
        completedNodeOutputs: [],
        abortRequested: false,
        registry: createCoreNodeRegistry(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded', output: { target: true } });
  });

  it('recursively prepares a For Each body node with exact ordinal-scoped upstream identity', async () => {
    const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
    const executable = buildWorkflowExecutable({
      graph: forEachGraph(),
      catalog,
    });
    const projection: PublishedWorkflow = {
      id: VERSION_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      versionNumber: 1,
      checksum: executable.checksum,
      executableJson: executable.envelope,
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
      catalog: catalog,
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
        registry: createPlatformNodeRegistry(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ nodeId: 'body-sink', kind: 'succeeded' });
  });
});
