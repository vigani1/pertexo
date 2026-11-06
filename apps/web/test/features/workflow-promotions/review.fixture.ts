import type { WorkflowPromotionPreview } from '@pertexo/contracts';
import { workspaceId, workflowId, versionId } from '../workflows/list/fixtures';
export const targetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const targetWorkflowId = '99999999-9999-4999-8999-999999999999';
const graph = { nodes: [], edges: [], settings: {} };
export const preview: WorkflowPromotionPreview = {
  fingerprint: 'a'.repeat(64),
  sourceWorkspaceId: workspaceId,
  sourceWorkspaceName: 'Development',
  targetWorkspaceId: targetId,
  targetWorkspaceName: 'Production',
  mode: 'draft',
  requireApproval: false,
  compatible: true,
  workflows: [
    {
      sourceWorkflowId: workflowId,
      sourceName: 'Release',
      sourceVersionId: versionId,
      sourceVersionNumber: 1,
      sourceChecksum: `wf:sha256:${'a'.repeat(64)}`,
      targetWorkflowId,
      targetName: 'Release',
      targetRevision: 2,
      targetPublishedVersionId: null,
      directChanges: true,
      proposedGraph: graph,
      targetGraph: graph,
    },
  ],
  requirements: [],
};
export function json(value: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}
