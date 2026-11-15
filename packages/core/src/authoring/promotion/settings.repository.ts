import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workspaceMemberships,
  workspacePromotionTargets,
} from '@pertexo/database/schema';
import type { SetPromotionTargetInput } from './workflow-promotion.types.js';

export async function readActiveMemberRole(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
) {
  const [member] = await drizzle(client)
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, actorId),
        eq(workspaceMemberships.status, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  return member?.role;
}

export async function savePromotionTarget(
  client: PoolClient,
  input: SetPromotionTargetInput,
  revision: number,
): Promise<void> {
  await drizzle(client)
    .insert(workspacePromotionTargets)
    .values({
      workspaceId: input.workspaceId,
      targetWorkspaceId: input.targetWorkspaceId,
      revision,
      updatedBy: input.actorId,
    })
    .onConflictDoUpdate({
      target: [workspacePromotionTargets.workspaceId],
      set: {
        targetWorkspaceId: sql`excluded.target_workspace_id`,
        revision: sql`excluded.revision`,
        updatedBy: sql`excluded.updated_by`,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .catch(rethrowQueryFailure);
}
