import { expect, it } from 'vitest';
import {
  approvalConfigSchema,
  InvalidWorkflowGraphError,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';
import { validateApprovalAudience } from '../../../src/authoring/publication/pending-tasks.queries.js';
import { admin, pool, taskFixture } from './fixtures.js';
function audienceGraph(id: string, nested: boolean): WorkflowGraph {
  const approval = {
    id: 'approval',
    definition: { key: 'core.approval', version: 1 },
    configVersion: 1,
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
    config: approvalConfigSchema.parse({
      audience: { roles: [], memberIds: [id] },
    }),
  };
  return {
    settings: {},
    edges: [],
    nodes: nested
      ? [
          {
            ...approval,
            id: 'loop',
            definition: { key: 'core.foreach', version: 1 },
            config: {},
            structured: {
              kind: 'for_each',
              maxIterations: 2,
              maxConcurrency: 1,
              body: {
                settings: {},
                nodes: [approval],
                edges: [],
                inputPorts: ['item'],
                outputPorts: ['out'],
              },
            },
          },
        ]
      : [approval],
  };
}
it.each([false, true])(
  'fences active named members for publication, nested %s',
  async (nested) => {
    const f = await taskFixture();
    const foreign = await taskFixture();
    const validate = (id: string) =>
      withTenantScopedClient(pool, { workspaceId: f.workspaceId }, (client) =>
        validateApprovalAudience(
          client,
          f.workspaceId,
          audienceGraph(id, nested),
        ),
      );
    await expect(validate(f.deciderId)).resolves.toBeUndefined();
    await expect(validate(foreign.deciderId)).rejects.toBeInstanceOf(
      InvalidWorkflowGraphError,
    );
    await admin.query(
      "update app.workspace_memberships set status='removed',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
      [f.workspaceId, f.deciderId],
    );
    await expect(validate(f.deciderId)).rejects.toBeInstanceOf(
      InvalidWorkflowGraphError,
    );
  },
);
