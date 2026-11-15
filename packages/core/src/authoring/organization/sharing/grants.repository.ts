import { generatePersistedId } from '@pertexo/database/platform';

import { z } from 'zod';

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

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import type { PoolClient } from 'pg';

import { FOLDER_GRANT_LIMIT } from '@pertexo/workflow-model';

import type { FolderSharingRequest, FolderPrincipal } from '@pertexo/contracts';

/** The command output retained for exact retries. */
export const sharingReceipt = z
  .object({
    folderId: z.uuid(),
    revision: z.number().int().positive(),
    mode: z.enum(['workspace', 'restricted']),
    grants: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('member'),
              userId: z.uuid(),
              access: z.enum(['viewer', 'editor']),
            })
            .strict(),
          z
            .object({
              kind: z.literal('group'),
              organizationId: z.uuid(),
              groupId: z.uuid(),
              access: z.enum(['viewer', 'editor']),
            })
            .strict(),
        ]),
      )
      .max(FOLDER_GRANT_LIMIT),
    labels: z.record(z.uuid(), z.string()).optional(),
  })
  .strict();

export async function readFolderAccess(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
) {
  const db = drizzle(client);
  const [folder] = await db
    .select({
      revision: workflowFolders.revision,
      mode: workflowFolders.accessMode,
    })
    .from(workflowFolders)
    .where(
      and(
        eq(workflowFolders.workspaceId, workspaceId),
        eq(workflowFolders.id, folderId),
      ),
    )
    .catch(rethrowQueryFailure);
  return folder;
}

/** The folder's grants with labels, one past the cap so an overfull set shows. */
export async function readFolderGrantRows(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
) {
  const db = drizzle(client);
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
    .where(and(eq(p.workspaceId, workspaceId), eq(p.folderId, folderId)))
    .orderBy(asc(p.id))
    .limit(FOLDER_GRANT_LIMIT + 1)
    .catch(rethrowQueryFailure);
  return rows;
}

export async function countActiveMembers(
  client: PoolClient,
  workspaceId: string,
  users: readonly string[],
): Promise<number> {
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
        eq(workspaceMemberships.workspaceId, workspaceId),
        inArray(workspaceMemberships.userId, [...users]),
        eq(workspaceMemberships.status, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  return members.length;
}

/** The requested groups whose organization links this workspace. */
export async function readLinkedGroups(
  client: PoolClient,
  workspaceId: string,
  groups: readonly Readonly<{ groupId: string }>[],
) {
  const db = drizzle(client);
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
        eq(authOrganizationWorkspaces.workspaceId, workspaceId),
      ),
    )
    .where(
      inArray(
        authDirectoryGroups.id,
        groups.map((grant) => grant.groupId),
      ),
    )
    .catch(rethrowQueryFailure);
  return linked;
}

/** Replaces the folder's grants and access mode, moving its revision. */
export async function replaceFolderGrants(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
  request: FolderSharingRequest,
): Promise<void> {
  const db = drizzle(client);
  await db
    .delete(workflowFolderGrants)
    .where(
      and(
        eq(workflowFolderGrants.workspaceId, workspaceId),
        eq(workflowFolderGrants.folderId, folderId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (request.grants.length > 0)
    await db
      .insert(workflowFolderGrants)
      .values(
        request.grants.map((grant) => ({
          id: generatePersistedId(),
          workspaceId: workspaceId,
          folderId: folderId,
          userId: grant.kind === 'member' ? grant.userId : null,
          organizationId: grant.kind === 'group' ? grant.organizationId : null,
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
        eq(workflowFolders.workspaceId, workspaceId),
        eq(workflowFolders.id, folderId),
      ),
    )
    .catch(rethrowQueryFailure);
}
