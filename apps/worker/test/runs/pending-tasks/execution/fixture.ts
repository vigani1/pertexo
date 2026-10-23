import { randomUUID } from 'node:crypto';

import {
  approvalConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';

import { fixture, edge, node } from '../../calls/fixtures.js';

export function graph(withHandler = false): WorkflowGraph {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('approval', 'core.approval'),
        config: approvalConfigSchema.parse({}),
      },
      ...['approved', 'rejected', ...(withHandler ? ['expired'] : [])].map(
        (id) => ({
          ...node(id, 'core.terminate'),
          inputMappings: { result: { kind: 'literal' as const, value: id } },
        }),
      ),
    ],
    edges: [
      edge('manual', 'approval'),
      edge('approval', 'approved', 'approved'),
      edge('approval', 'rejected', 'rejected'),
      ...(withHandler ? [edge('approval', 'expired', '__failure')] : []),
    ],
  };
}

export let deciderId: string;

export async function prepareApprovalThroughRealWorkersDurableTasks() {
  deciderId = randomUUID();
  await fixture.ownerQuery(
    "insert into app.users(id,email,display_name) values($1,$2,'Approval decider')",
    [deciderId, `${deciderId}@example.test`],
  );
  await fixture.ownerQuery(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'admin','active')",
    [fixture.workspaceId, deciderId],
  );
}
