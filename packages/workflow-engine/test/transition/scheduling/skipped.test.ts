import { describe, expect, it } from 'vitest';

import { invocationKey } from '../../../src/index.js';

import { deriveReadyNodes } from '../../support/engine.js';
import {
  workflowVersionId,
  pairedSchedulerGraph,
  scopedInvocation,
} from '../../support/scheduling/skipped-parallel.js';

describe('skipped Parallel/Merge scheduling', () => {
  it('emits one scoped skipped paired Merge after a skipped Parallel', () => {
    const branchPath = [{ nodeId: 'condition', outputPort: 'false' }] as const;
    const graph = pairedSchedulerGraph(true);
    const invocations = [
      scopedInvocation(workflowVersionId, 'parallel', 'skipped', {
        branchPath,
      }),
      scopedInvocation(workflowVersionId, 'left', 'skipped', {
        branchPath: [
          ...branchPath,
          { nodeId: 'parallel', outputPort: 'branch-01' },
        ],
      }),
      scopedInvocation(workflowVersionId, 'right', 'skipped', {
        branchPath: [
          ...branchPath,
          { nodeId: 'parallel', outputPort: 'branch-02' },
        ],
      }),
      scopedInvocation(workflowVersionId, 'guard', 'succeeded', {
        branchPath,
      }),
    ];

    expect(
      deriveReadyNodes({
        graph,
        workflowVersionId,
        invocations,
        branchPath,
      }),
    ).toEqual([
      {
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'after',
          branchPath: ['condition:false'],
        }),
        nodeId: 'after',
        disposition: 'skipped',
        branchPath,
      },
      {
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'merge',
          branchPath: ['condition:false'],
        }),
        nodeId: 'merge',
        disposition: 'skipped',
        branchPath,
      },
    ]);
  });
  it('keeps a successful paired Parallel as a Merge barrier without a join', () => {
    const graph = pairedSchedulerGraph();
    const invocations = [
      scopedInvocation(workflowVersionId, 'parallel', 'succeeded'),
      scopedInvocation(workflowVersionId, 'left', 'skipped', {
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-01' }],
      }),
      scopedInvocation(workflowVersionId, 'right', 'skipped', {
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-02' }],
      }),
    ];

    expect(
      deriveReadyNodes({
        graph,
        workflowVersionId,
        invocations,
      }).some((decision) => decision.nodeId === 'merge'),
    ).toBe(false);
  });
  it('skips a paired Merge without fabricating an absent branch scope', () => {
    const graph = pairedSchedulerGraph();
    const invocations = [
      scopedInvocation(workflowVersionId, 'parallel', 'skipped'),
      scopedInvocation(workflowVersionId, 'left', 'skipped', {
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-01' }],
      }),
      scopedInvocation(workflowVersionId, 'right', 'skipped', {
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-02' }],
      }),
    ];

    expect(
      deriveReadyNodes({ graph, workflowVersionId, invocations }),
    ).toContainEqual({
      invocationKey: invocationKey({ workflowVersionId, nodeId: 'merge' }),
      nodeId: 'merge',
      disposition: 'skipped',
    });
  });
  it('keeps skipped Merge scope isolated across nested iteration paths', () => {
    const branchPath = [{ nodeId: 'switch', outputPort: 'default' }] as const;
    const iterationPath = [{ loopNodeId: 'loop', ordinal: 2 }] as const;
    const parallelPath = [
      ...branchPath,
      { nodeId: 'parallel', outputPort: 'branch-01' },
    ] as const;
    const graph = pairedSchedulerGraph();
    const invocations = [
      scopedInvocation(workflowVersionId, 'parallel', 'skipped', {
        branchPath,
        iterationPath,
      }),
      scopedInvocation(workflowVersionId, 'left', 'skipped', {
        branchPath: parallelPath,
        iterationPath,
      }),
      scopedInvocation(workflowVersionId, 'right', 'skipped', {
        branchPath: [
          ...branchPath,
          { nodeId: 'parallel', outputPort: 'branch-02' },
        ],
        iterationPath,
      }),
    ];

    expect(
      deriveReadyNodes({
        graph,
        workflowVersionId,
        invocations,
        branchPath,
        iterationPath,
      }),
    ).toEqual([
      {
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'after',
          branchPath: ['switch:default'],
          iterationPath,
        }),
        nodeId: 'after',
        disposition: 'skipped',
        branchPath,
        iterationPath,
      },
      {
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'merge',
          branchPath: ['switch:default'],
          iterationPath,
        }),
        nodeId: 'merge',
        disposition: 'skipped',
        branchPath,
        iterationPath,
      },
    ]);
  });
  it('does not infer a skipped or ready Merge from generic all-skipped predecessors', () => {
    const graph = pairedSchedulerGraph();
    const invocations = [
      scopedInvocation(workflowVersionId, 'left', 'skipped'),
      scopedInvocation(workflowVersionId, 'right', 'skipped'),
    ];

    expect(
      deriveReadyNodes({ graph, workflowVersionId, invocations }),
    ).not.toContainEqual(expect.objectContaining({ nodeId: 'merge' }));
  });
});
