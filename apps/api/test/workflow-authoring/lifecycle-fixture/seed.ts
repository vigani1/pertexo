import { randomUUID } from 'node:crypto';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { testExecutableCompiler } from '@pertexo/core/testing';

import type { Pool } from 'pg';
import type { PoolClient } from 'pg';

import type { LifecycleWorkflowIds } from './contract.js';
import { withOwnerClient } from './database.js';

export async function seedWorkflowRows(
  client: PoolClient,
  workspaceId: string,
  ownerUserId: string,
  ids: LifecycleWorkflowIds,
): Promise<void> {
  const graph = JSON.stringify({
    nodes: [],
    edges: [],
    settings: {},
  });
  const compiled = testExecutableCompiler(
    parseWorkflowGraphDraft(JSON.parse(graph)),
  );
  await client.query(
    `insert into app.workflows
           (id,workspace_id,name,lifecycle_status,activation_status,
            lifecycle_revision,published_version_id,created_by)
         values
           ($1,$2,'Unpublished lifecycle target','active','inactive',1,null,$3),
           ($4,$2,'Published lifecycle target','active','inactive',1,null,$3)`,
    [ids.unpublished, workspaceId, ownerUserId, ids.published],
  );
  await client.query(
    `insert into app.workflow_drafts
       (workflow_id,workspace_id,revision,graph_json,updated_by)
     values
       ($1,$2,7,$3::jsonb,$4),
       ($5,$2,11,$3::jsonb,$4)`,
    [ids.unpublished, workspaceId, graph, ownerUserId, ids.published],
  );
  await client.query(
    `insert into app.workflow_versions
       (id,workspace_id,workflow_id,version_number,
        graph_json,checksum,executable_json,published_by)
     values ($1,$2,$3,4,$4::jsonb,$5,$6::jsonb,$7)`,
    [
      ids.publishedVersion,
      workspaceId,
      ids.published,
      graph,
      compiled.checksum,
      JSON.stringify(compiled.executableJson),
      ownerUserId,
    ],
  );
  await client.query(
    `update app.workflows set published_version_id=$2 where id=$1`,
    [ids.published, ids.publishedVersion],
  );
}

export async function createForeignVersionWithOwner(
  ownerPool: Pool,
  ownerUserId: string,
): Promise<string> {
  const foreignWorkspaceId = randomUUID();
  const foreignWorkflowId = randomUUID();
  const foreignVersionId = randomUUID();
  const graph = parseWorkflowGraphDraft({
    nodes: [],
    edges: [],
    settings: {},
  });
  const compiled = testExecutableCompiler(graph);
  await withOwnerClient(ownerPool, foreignWorkspaceId, async (client) => {
    await client.query(
      `insert into app.workspaces (id,name,slug,status,created_by)
       values ($1,'Foreign version source',$2,'active',$3)`,
      [
        foreignWorkspaceId,
        `foreign-version-${foreignWorkspaceId.slice(0, 12)}`,
        ownerUserId,
      ],
    );
    await client.query(
      `insert into app.workflows
         (id,workspace_id,name,lifecycle_status,activation_status,
          lifecycle_revision,published_version_id,created_by)
       values ($1,$2,'Foreign workflow','active','inactive',1,null,$3)`,
      [foreignWorkflowId, foreignWorkspaceId, ownerUserId],
    );
    await client.query(
      `insert into app.workflow_versions
         (id,workspace_id,workflow_id,version_number,
          graph_json,checksum,executable_json,published_by)
       values ($1,$2,$3,1,$4::jsonb,$5,$6::jsonb,$7)`,
      [
        foreignVersionId,
        foreignWorkspaceId,
        foreignWorkflowId,
        JSON.stringify(graph),
        compiled.checksum,
        JSON.stringify(compiled.executableJson),
        ownerUserId,
      ],
    );
  });
  return foreignVersionId;
}

export async function setWorkspaceStatusWithOwner(
  ownerPool: Pool,
  workspaceId: string,
  ownerUserId: string,
  status: 'active' | 'suspended' | 'pending_deletion',
): Promise<void> {
  await withOwnerClient(ownerPool, workspaceId, async (client) => {
    if (status === 'pending_deletion') {
      await client.query(
        `update app.workspaces
         set status='pending_deletion',deletion_requested_at=clock_timestamp(),
             deletion_requested_by=$2,deletion_reason='integration test',
             purge_after=clock_timestamp()+interval '1 day'
         where id=$1`,
        [workspaceId, ownerUserId],
      );
      return;
    }
    await client.query(
      `update app.workspaces
       set status=$2,deletion_requested_at=null,deletion_requested_by=null,
           deletion_reason=null,purge_after=null
       where id=$1`,
      [workspaceId, status],
    );
  });
}
