import { NodeAttemptHandlerStateError } from '../../src/attempts/delivery/handler-state-error.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  NodeAttemptLease,
  PublishedWorkflow,
} from '@pertexo/core/testing';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import {
  composeExecutableCatalog,
  invocationKey,
  buildWorkflowExecutable,
} from '@pertexo/workflow-engine';
import { createNodeAttemptExecutionEngine } from '../../src/attempts/execution/engine.js';
import {
  RUN_ID,
  VERSION_ID,
  graph,
  WORKFLOW_ID,
  WORKSPACE_ID,
} from '../support/attempts/execution-engine.js';
import {
  ATTEMPT_ID,
  OUTBOX_ID,
  branchGraph,
  compiledProjection,
  fixture,
  forEachGraph,
  parallelMergeGraph,
  nestedBranchGraph,
} from './engine.fixture.js';

import { createPlatformNodeRegistry } from '../../src/providers/node-registry.js';

describe('node attempt execution engine', () => {
  it('substitutes a test pin before mappings, input capture or executor dispatch', async () => {
    const { catalog, projection, lease } = fixture('terminate');
    const execute = vi.fn();
    const onInputResolved = vi.fn().mockResolvedValue(undefined);
    const prepared = createNodeAttemptExecutionEngine({ catalog }).prepare({
      lease,
      projection: {
        ...projection,
        test: { pinnedNodeIds: ['terminate'] },
        testSample: { sampleId: OUTBOX_ID, output: { sample: 'frozen' } },
      },
    });
    expect(prepared.upstreamNodeOutputs).toEqual([]);
    await expect(
      prepared.execute({
        runInput: { different: true },
        completedNodeOutputs: [],
        control: { kind: 'none' },
        registry: { execute },
        onInputResolved,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'terminal_success',
      output: { sample: 'frozen' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(onInputResolved).not.toHaveBeenCalled();
  });

  it('keeps normal Wait suspension but completes it immediately in a draft test', async () => {
    const { catalog, lease } = fixture('manual');
    const source = graph();
    const projection = compiledProjection(
      {
        ...source,
        nodes: source.nodes.map((node) =>
          node.id === 'manual'
            ? {
                ...node,
                definition: { key: 'core.wait', version: 1 },
                config: { durationSeconds: 3600 },
              }
            : node,
        ),
      },
      catalog,
    );
    const engine = createNodeAttemptExecutionEngine({ catalog });
    expect(
      engine.prepare({ lease, projection }).suspensionDurationSeconds,
    ).toBe(3600);
    const prepared = engine.prepare({
      lease,
      projection: { ...projection, test: { pinnedNodeIds: [] } },
    });
    expect(prepared.suspensionDurationSeconds).toBeUndefined();
    await expect(
      prepared.execute({
        runInput: {},
        completedNodeOutputs: [],
        control: { kind: 'none' },
        registry: createCoreNodeRegistry(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
  });

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
        control: { kind: 'none' },
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
          control: { kind: 'none' },
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

    const prepare = () =>
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
      });
    expect(prepare).toThrow(NodeAttemptHandlerStateError);
    expect(prepare).toThrow(
      expect.objectContaining({ code: 'workflow_node_missing' }),
    );
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
        control: { kind: 'abort', reason: 'canceled' },
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
        control: { kind: 'none' },
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
        control: { kind: 'none' },
        registry: createPlatformNodeRegistry(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ nodeId: 'body-sink', kind: 'succeeded' });
  });
});
