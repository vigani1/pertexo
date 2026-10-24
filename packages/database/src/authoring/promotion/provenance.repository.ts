import type { PoolClient } from 'pg';
import type { WorkflowVersionRecord } from '../workflows/representation/contract.js';
import { promotionDigest } from './preparation/graph.js';

/** Only the unchanged promoted draft can attribute a published version to its source. */
export async function recordPromotedPublication(
  client: PoolClient,
  version: WorkflowVersionRecord,
): Promise<void> {
  const row = (
    await client.query<{ graph_digest: string }>(
      `select origin.graph_digest from app.workflow_promotion_origins origin
     join app.workflows workflow on workflow.workspace_id=origin.workspace_id and workflow.id=origin.workflow_id
     join app.workflow_drafts draft on draft.workspace_id=workflow.workspace_id and draft.workflow_id=workflow.id
     where origin.workspace_id=$1 and origin.workflow_id=$2 and workflow.name=origin.target_name and draft.revision=origin.draft_revision`,
      [version.workspaceId, version.workflowId],
    )
  ).rows[0];
  if (row?.graph_digest !== promotionDigest(version.graphJson)) return;
  await client.query(
    `insert into app.workflow_version_promotions(workspace_id,workflow_id,version_id,source_workspace_id,source_workflow_id,source_version_id,source_checksum,promotion_id)
    select workspace_id,workflow_id,$3,source_workspace_id,source_workflow_id,source_version_id,source_checksum,promotion_id from app.workflow_promotion_origins where workspace_id=$1 and workflow_id=$2 on conflict do nothing`,
    [version.workspaceId, version.workflowId, version.id],
  );
  await client.query(
    'update app.workflow_promotion_origins set published_version_id=$3 where workspace_id=$1 and workflow_id=$2',
    [version.workspaceId, version.workflowId, version.id],
  );
}
