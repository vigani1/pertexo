import { expect } from 'vitest';

import { workerQuery, workspaceId } from '../fixture.js';
import type { ForEachPhaseContext } from './contract.js';

export async function assertStructuredLoopChildren(
  context: Pick<ForEachPhaseContext, 'accepted' | 'structuredKind'>,
) {
  const { accepted, structuredKind } = context;

  const scopedChildren = await workerQuery<{
    branch_context: {
      branchPath: { nodeId: string; outputPort: string }[];
      iterationPath: { loopNodeId: string; ordinal: number }[];
    };
    node_id: string;
  }>(
    `select node_id,branch_context from app.node_runs
                where workspace_id=$1 and workflow_run_id=$2 and node_id=$3
                order by (branch_context->'iterationPath'->0->>'ordinal')::int`,
    [
      workspaceId,
      accepted.runId,
      structuredKind === 'nested' ? 'nested-body' : 'body-sink',
    ],
  );
  expect(scopedChildren).toHaveLength(3);
  for (const [ordinal, child] of scopedChildren.entries()) {
    expect(child.branch_context.iterationPath).toEqual(
      structuredKind === 'nested'
        ? [
            { loopNodeId: 'for-each', ordinal },
            { loopNodeId: 'body-map', ordinal: 0 },
          ]
        : [{ loopNodeId: 'for-each', ordinal }],
    );
    expect(child.branch_context.branchPath).toEqual(
      structuredKind === 'nested'
        ? []
        : [
            {
              nodeId: 'body-map',
              outputPort: structuredKind === 'condition' ? 'true' : 'case-01',
            },
          ],
    );
  }
  await expect(
    workerQuery<{ node_id: string; attempts: string }>(
      `select node.node_id,count(attempt.id)::text attempts
                   from app.node_runs node
                   join app.node_attempts attempt on attempt.node_run_id=node.id
                  where node.workspace_id=$1 and node.workflow_run_id=$2
                    and node.node_id=$3
                  group by node.node_id`,
      [workspaceId, accepted.runId, scopedChildren[0]?.node_id],
    ),
  ).resolves.toEqual([{ node_id: scopedChildren[0]?.node_id, attempts: '3' }]);
}
