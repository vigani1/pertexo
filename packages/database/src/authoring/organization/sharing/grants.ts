import { canonicalOutboxPayloadChecksum } from '../../../outbox/events.repository.js';
import type { PoolClient } from 'pg';
import type {
  FolderSharing,
  FolderSharingRequest,
  FolderPrincipal,
} from '@pertexo/contracts';
import { RESOURCE_ADMINISTRATORS } from '../../../tenant-access/resources/policy.js';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';
import { WorkflowNotFoundError } from '../../workflows/errors.js';
import { WorkflowFolderConflictError } from '../errors.js';
import type { OrganizationScope } from '../command.js';
import { runOrganizationCommand } from '../command.js';

export async function readFolderSharing(
  client: PoolClient,
  scope: OrganizationScope,
  folderId: string,
): Promise<FolderSharing> {
  await lockWorkflowAuthoringAuthority(client, scope.workspaceId, {
    actorId: scope.actorId,
    roles: RESOURCE_ADMINISTRATORS,
  });
  const folder = (
    await client.query<{
      revision: string;
      access_mode: FolderSharing['mode'];
    }>(
      'select revision,access_mode from app.workflow_folders where workspace_id=$1 and id=$2',
      [scope.workspaceId, folderId],
    )
  ).rows[0];
  if (folder === undefined)
    throw new WorkflowNotFoundError('Folder is not visible');
  const rows = (
    await client.query<{ principal: FolderPrincipal; label: string }>(
      `select case when permission.user_id is not null then jsonb_build_object('kind','member','userId',permission.user_id,'access',permission.access)
      else jsonb_build_object('kind','group','organizationId',permission.organization_id,'groupId',permission.group_id,'access',permission.access) end principal,coalesce(person.display_name,directory.display_name,'Unavailable principal') label
      from app.workflow_folder_grants permission
      left join app.users person on person.id=permission.user_id
      left join app.auth_organization_workspaces link on link.workspace_id=permission.workspace_id and link.organization_id=permission.organization_id
      left join app.auth_directory_groups directory on directory.organization_id=link.organization_id and directory.id=permission.group_id
      where permission.workspace_id=$1 and permission.folder_id=$2 order by permission.id limit 101`,
      [scope.workspaceId, folderId],
    )
  ).rows;
  const grants = rows.map(({ principal }) => principal);
  if (grants.length > 100)
    throw new Error('Folder grants exceed the supported bound');
  return {
    folderId,
    revision: Number(folder.revision),
    mode: folder.access_mode,
    grants,
    labels: Object.fromEntries(
      rows.map(({ principal, label }) => [
        principal.kind === 'member' ? principal.userId : principal.groupId,
        label,
      ]),
    ),
  };
}

export async function replaceFolderSharing(
  client: PoolClient,
  scope: OrganizationScope,
  input: {
    folderId: string;
    request: FolderSharingRequest;
    idempotencyKey: string;
  },
): Promise<FolderSharing & { replayed: boolean }> {
  const request = input.request;
  const outcome = await runOrganizationCommand(client, scope, {
    operation: 'folder.sharing',
    target: input.folderId,
    roles: RESOURCE_ADMINISTRATORS,
    idempotencyKey: input.idempotencyKey,
    request,
    replay: async () => {
      await readFolderSharing(client, scope, input.folderId);
    },
    apply: async () => {
      const current = await readFolderSharing(client, scope, input.folderId);
      if (current.revision !== request.expectedFolderRevision)
        throw new WorkflowFolderConflictError('revision');
      const users = request.grants.flatMap((grant) =>
        grant.kind === 'member' ? [grant.userId] : [],
      );
      const groups = request.grants.filter((grant) => grant.kind === 'group');
      const members = await client.query(
        `select member.user_id from app.workspace_memberships member
        join app.users person on person.id=member.user_id and person.status='active'
        where member.workspace_id=$1 and member.user_id=any($2::uuid[]) and member.status='active'`,
        [scope.workspaceId, users],
      );
      const linked = await client.query<{
        organization_id: string;
        id: string;
      }>(
        `select directory.organization_id,directory.id
        from app.auth_directory_groups directory join app.auth_organization_workspaces link
        on link.organization_id=directory.organization_id and link.workspace_id=$1
        where directory.id=any($2::uuid[])`,
        [scope.workspaceId, groups.map((grant) => grant.groupId)],
      );
      if (
        members.rows.length !== users.length ||
        groups.some(
          (grant) =>
            !linked.rows.some(
              (row) =>
                row.organization_id === grant.organizationId &&
                row.id === grant.groupId,
            ),
        )
      )
        throw new WorkflowNotFoundError('A sharing principal is unavailable');
      await client.query(
        'delete from app.workflow_folder_grants where workspace_id=$1 and folder_id=$2',
        [scope.workspaceId, input.folderId],
      );
      for (const grant of request.grants)
        await client.query(
          `insert into app.workflow_folder_grants
        (id,workspace_id,folder_id,user_id,organization_id,group_id,access) values(uuidv7(),$1,$2,$3,$4,$5,$6)`,
          [
            scope.workspaceId,
            input.folderId,
            grant.kind === 'member' ? grant.userId : null,
            grant.kind === 'group' ? grant.organizationId : null,
            grant.kind === 'group' ? grant.groupId : null,
            grant.access,
          ],
        );
      await client.query(
        'update app.workflow_folders set access_mode=$3,revision=revision+1 where workspace_id=$1 and id=$2',
        [scope.workspaceId, input.folderId, request.mode],
      );
      return {
        result: await readFolderSharing(client, scope, input.folderId),
        audit: {
          action: 'workflow.folder_sharing_changed',
          targetId: input.folderId,
          metadata: {
            mode: request.mode,
            principals: request.grants.length,
            previousGrants: canonicalOutboxPayloadChecksum(current.grants),
            grants: canonicalOutboxPayloadChecksum(request.grants),
            revision: current.revision + 1,
          },
        },
      };
    },
  });
  return { ...outcome.result, replayed: outcome.replayed };
}
