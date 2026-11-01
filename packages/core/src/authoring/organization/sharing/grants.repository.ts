import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowFolders,
  workflowFolderGrants,
  users as people,
  workspaceMemberships,
  authDirectoryGroups,
  authOrganizationWorkspaces,
} from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  canonicalOutboxPayloadChecksum,
} from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { FOLDER_GRANT_LIMIT } from '@pertexo/workflow-model';
import type {
  FolderSharing,
  FolderSharingRequest,
  FolderPrincipal,
} from '@pertexo/contracts';
import { RESOURCE_ADMINISTRATORS } from '../../../tenant-access/resources/policy.js';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';
import { WorkflowNotFoundError } from '../../workflows/errors.js';
import {
  FolderSharingCorruptError,
  WorkflowFolderConflictError,
} from '../errors.js';
import type { OrganizationScope } from '../commands.repository.js';
import { runOrganizationCommand } from '../commands.repository.js';

export async function readFolderSharing(
  client: PoolClient,
  scope: OrganizationScope,
  folderId: string,
  { browsing = false }: Readonly<{ browsing?: boolean }> = {},
): Promise<FolderSharing> {
  await lockWorkflowAuthoringAuthority(client, scope.workspaceId, {
    actorId: scope.actorId,
    browsing,
    roles: RESOURCE_ADMINISTRATORS,
  });
  const db = drizzle(client);
  const [folder] = await db
    .select({
      revision: workflowFolders.revision,
      mode: workflowFolders.accessMode,
    })
    .from(workflowFolders)
    .where(
      and(
        eq(workflowFolders.workspaceId, scope.workspaceId),
        eq(workflowFolders.id, folderId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (folder === undefined)
    throw new WorkflowNotFoundError('Folder is not visible');
  const p = workflowFolderGrants;
  const rows = await db
    .select({
      // The principal CHECK fixes the member/group shape of this computed JSON.
      principal: sql<FolderPrincipal>`case when ${p.userId} is not null then jsonb_build_object('kind','member','userId',${p.userId},'access',${p.access}) else jsonb_build_object('kind','group','organizationId',${p.organizationId},'groupId',${p.groupId},'access',${p.access}) end`,
      label: sql<string>`coalesce(${people.displayName},${authDirectoryGroups.displayName},'Unavailable principal')`,
    })
    .from(p)
    .leftJoin(people, eq(people.id, p.userId))
    .leftJoin(
      authOrganizationWorkspaces,
      and(
        eq(authOrganizationWorkspaces.workspaceId, p.workspaceId),
        eq(authOrganizationWorkspaces.organizationId, p.organizationId),
      ),
    )
    .leftJoin(
      authDirectoryGroups,
      and(
        eq(
          authDirectoryGroups.organizationId,
          authOrganizationWorkspaces.organizationId,
        ),
        eq(authDirectoryGroups.id, p.groupId),
      ),
    )
    .where(and(eq(p.workspaceId, scope.workspaceId), eq(p.folderId, folderId)))
    .orderBy(asc(p.id))
    .limit(FOLDER_GRANT_LIMIT + 1)
    .catch(rethrowQueryFailure);
  const grants = rows.map(({ principal }) => principal);
  if (grants.length > FOLDER_GRANT_LIMIT) throw new FolderSharingCorruptError();
  return {
    folderId,
    revision: folder.revision,
    mode: folder.mode,
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
      const db = drizzle(client);
      const members = await db
        .select({ userId: workspaceMemberships.userId })
        .from(workspaceMemberships)
        .innerJoin(
          people,
          and(
            eq(people.id, workspaceMemberships.userId),
            eq(people.status, 'active'),
          ),
        )
        .where(
          and(
            eq(workspaceMemberships.workspaceId, scope.workspaceId),
            inArray(workspaceMemberships.userId, users),
            eq(workspaceMemberships.status, 'active'),
          ),
        )
        .catch(rethrowQueryFailure);
      const linked = await db
        .select({
          organizationId: authDirectoryGroups.organizationId,
          id: authDirectoryGroups.id,
        })
        .from(authDirectoryGroups)
        .innerJoin(
          authOrganizationWorkspaces,
          and(
            eq(
              authOrganizationWorkspaces.organizationId,
              authDirectoryGroups.organizationId,
            ),
            eq(authOrganizationWorkspaces.workspaceId, scope.workspaceId),
          ),
        )
        .where(
          inArray(
            authDirectoryGroups.id,
            groups.map((grant) => grant.groupId),
          ),
        )
        .catch(rethrowQueryFailure);
      if (
        members.length !== users.length ||
        groups.some(
          (grant) =>
            !linked.some(
              (row) =>
                row.organizationId === grant.organizationId &&
                row.id === grant.groupId,
            ),
        )
      )
        throw new WorkflowNotFoundError('A sharing principal is unavailable');
      await db
        .delete(workflowFolderGrants)
        .where(
          and(
            eq(workflowFolderGrants.workspaceId, scope.workspaceId),
            eq(workflowFolderGrants.folderId, input.folderId),
          ),
        )
        .catch(rethrowQueryFailure);
      if (request.grants.length > 0)
        await db
          .insert(workflowFolderGrants)
          .values(
            request.grants.map((grant) => ({
              id: sql`uuidv7()`,
              workspaceId: scope.workspaceId,
              folderId: input.folderId,
              userId: grant.kind === 'member' ? grant.userId : null,
              organizationId:
                grant.kind === 'group' ? grant.organizationId : null,
              groupId: grant.kind === 'group' ? grant.groupId : null,
              access: grant.access,
            })),
          )
          .catch(rethrowQueryFailure);
      await db
        .update(workflowFolders)
        .set({
          accessMode: request.mode,
          revision: sql`${workflowFolders.revision}+1`,
        })
        .where(
          and(
            eq(workflowFolders.workspaceId, scope.workspaceId),
            eq(workflowFolders.id, input.folderId),
          ),
        )
        .catch(rethrowQueryFailure);
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
