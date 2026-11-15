import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaces,
  workspacePromotionTargets,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkspaceScopeRunner } from '@pertexo/database/primitives';
import {
  rolesForCapability,
  type AuthorizationCapability,
} from '@pertexo/policy';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import type { PromotionScope } from './workflow-promotion.types.js';

export type PromotionLink = Readonly<{
  revision: number;
  targetWorkspaceId: string | null;
}>;
export async function readPromotionLink(
  client: PoolClient,
  workspaceId: string,
): Promise<PromotionLink> {
  const row = (
    await drizzle(client)
      .select({
        revision: workspacePromotionTargets.revision,
        target_workspace_id: workspacePromotionTargets.targetWorkspaceId,
      })
      .from(workspacePromotionTargets)
      .where(eq(workspacePromotionTargets.workspaceId, workspaceId))
      .catch(rethrowQueryFailure)
  )[0];
  return {
    revision: row?.revision ?? 0,
    targetWorkspaceId: row?.target_workspace_id ?? null,
  };
}
export function requirePromotionAuthority(
  client: PoolClient,
  input: PromotionScope,
  capability: AuthorizationCapability = 'workflow:update',
  { browsing = false }: Readonly<{ browsing?: boolean }> = {},
) {
  return lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    browsing,
    roles: rolesForCapability(capability),
  });
}
/**
 * Both directions acquire workspace locks in the same order before membership or
 * workflow locks. That's why promotion's commands stay off `withWorkspaceAccess`: one
 * transaction covers two workspaces, and the helper opens a transaction per workspace.
 */
export async function lockPromotionWorkspaces(
  inWorkspace: WorkspaceScopeRunner,
  input: PromotionScope,
  targetWorkspaceId: string | null,
): Promise<void> {
  for (const workspaceId of [
    ...new Set([
      input.workspaceId,
      ...(targetWorkspaceId === null ? [] : [targetWorkspaceId]),
    ]),
  ].sort()) {
    await inWorkspace(
      { workspaceId, actorId: input.actorId },
      async (client) => {
        await drizzle(client)
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .for('update')
          .catch(rethrowQueryFailure);
      },
    );
  }
}

/** The workspace's name and whether it requires publish approval. */
export async function readWorkspaceNaming(
  client: PoolClient,
  workspaceId: string,
) {
  const [row] = await drizzle(client)
    .select({
      name: workspaces.name,
      require_publish_approval: workspaces.requirePublishApproval,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
  return row;
}
