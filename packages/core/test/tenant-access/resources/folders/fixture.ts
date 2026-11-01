import { withTenantScopedClient } from '@pertexo/database/primitives';
import { randomUUID } from 'node:crypto';

import {
  actorId,
  apiUrl,
  apiPool,
  authoring,
  emptyGraph,
  identity,
  queryAsOwner,
  workspaceId,
  workflowId,
} from '../../../support/workflow-authoring.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createWorkflowFolderDatabase } from '../../../../src/authoring/organization/folders/commands.repository.js';
import { createWorkflowOrganizationReadDatabase } from '../../../../src/authoring/organization/workflows.queries.js';
import { createWorkflowRunDatabase } from '../../../../src/runs/runs.repository.js';

export const builder = randomUUID(),
  viewer = randomUUID();

export let folderId = '',
  publicId = '',
  privateRun = '',
  publicRun = '';

export let folders: ReturnType<typeof createWorkflowFolderDatabase>;

export let organization: ReturnType<
  typeof createWorkflowOrganizationReadDatabase
>;

export let runs: ReturnType<typeof createWorkflowRunDatabase>;

export async function beforeAllFixture1() {
  const config = parseDatabaseConfig({ connectionString: apiUrl, max: 3 });
  folders = createWorkflowFolderDatabase(config);
  organization = createWorkflowOrganizationReadDatabase(config);
  runs = createWorkflowRunDatabase(config);
  for (const id of [builder, viewer])
    await identity.createUser({
      id,
      email: `${id}@example.test`,
      displayName: 'Resource reader',
    });
  await queryAsOwner(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active'),($1,$3,'viewer','active')",
    [workspaceId, builder, viewer],
    workspaceId,
  );
  folderId = (
    await folders.createFolder({
      workspaceId,
      actorId,
      name: 'Private',
      parentId: null,
      idempotencyKey: randomUUID(),
    })
  ).folder.id;
  await folders.placeWorkflow({
    workspaceId,
    actorId,
    workflowId,
    folderId,
    expectedOrganizationRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await queryAsOwner(
    "update app.workflow_folders set access_mode='restricted' where workspace_id=$1 and id=$2",
    [workspaceId, folderId],
    workspaceId,
  );
  publicId = (
    await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: 'Public',
      emptyGraph,
      idempotencyKey: randomUUID(),
    })
  ).workflowId;
  for (const [id, isPrivate] of [
    [workflowId, true],
    [publicId, false],
  ] as const) {
    const version = randomUUID(),
      run = randomUUID();
    await queryAsOwner(
      "insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,1,$4::json,'{}','wf:sha256:'||repeat('a',64),$5)",
      [version, workspaceId, id, JSON.stringify(emptyGraph), actorId],
      workspaceId,
    );
    await withTenantScopedClient(apiPool, { workspaceId }, (client) =>
      client.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at,started_at,completed_at,input_ref,input_ref_expires_at)
       values($1,$2,$3,$4,'manual',$5,clock_timestamp()-interval '10 seconds',clock_timestamp()-interval '9 seconds',clock_timestamp()-interval '1 second','{"kind":"inline","value":{"private":true}}',clock_timestamp()+interval '29 days')`,
        [run, workspaceId, id, version, isPrivate ? 'failed' : 'succeeded'],
      ),
    );
    if (isPrivate) privateRun = run;
    else publicRun = run;
  }
}

export async function afterAllFixture2() {
  await Promise.all([folders.close(), organization.close(), runs.close()]);
}
