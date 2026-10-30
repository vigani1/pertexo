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
import { expect, it, vi } from 'vitest';
import { createNodeAttemptExecutionEngine } from '../../../src/attempts/execution/engine.js';
import {
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from '../../support/attempts/execution-engine.js';
import {
  forEachGraph,
  parallelMergeGraph,
  nestedBranchGraph,
  compiledProjection,
  fixture,
} from './fixture.js';

export function registerKeepsNestedBranchAncestryRemovesIntroducing(): void {
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
}
