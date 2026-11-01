import { randomUUID } from 'node:crypto';
import { createWorkflowRunDatabase } from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';

type OwnerQuery = <T extends Record<string, unknown>>(
  statement: string,
  parameters?: readonly unknown[],
) => Promise<readonly T[]>;
/** Restrict fresh fixture workflows after their immutable execution was accepted. */
export async function restrictAcceptedWorkflows(
  input: Readonly<{
    ownerQuery: OwnerQuery;
    workspaceId: string;
    workflowIds: readonly string[];
    apiUrl: string;
  }>,
) {
  const actorId = randomUUID(),
    folderId = randomUUID();
  await input.ownerQuery(
    'insert into app.users(id,email,display_name) values($1,$2,$3)',
    [actorId, `${actorId}@example.test`, 'Former workflow reader'],
  );
  await input.ownerQuery(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
    [input.workspaceId, actorId],
  );
  const reads = createWorkflowRunDatabase(
    parseDatabaseConfig({ connectionString: input.apiUrl, max: 1 }),
  );
  try {
    await input.ownerQuery(
      "insert into app.workflow_folders(id,workspace_id,name,name_key,access_mode) values($1,$2,'Private accepted work','private accepted work','restricted')",
      [folderId, input.workspaceId],
    );
    for (const workflowId of input.workflowIds)
      await input.ownerQuery(
        'insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3)',
        [input.workspaceId, workflowId, folderId],
      );
    return {
      canRead: (runId: string) =>
        reads.canRead({ workspaceId: input.workspaceId, actorId, runId }),
      close: async () => {
        await reads.close();
        await input.ownerQuery(
          'delete from app.workflow_organization_state where workspace_id=$1 and workflow_id=any($2::uuid[])',
          [input.workspaceId, input.workflowIds],
        );
        await input.ownerQuery(
          'delete from app.workflow_folders where workspace_id=$1 and id=$2',
          [input.workspaceId, folderId],
        );
      },
    };
  } catch (error) {
    await reads.close();
    throw error;
  }
}
