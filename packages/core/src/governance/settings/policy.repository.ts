import type { PoolClient } from 'pg';
import type { GovernanceSettings } from '@pertexo/contracts';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  users,
  workflowPublicationRequests,
  workspaceMemberships,
  workspaces,
} from '@pertexo/database/schema';
import { rolesForCapability } from '@pertexo/policy';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { GovernanceError } from '../governance.errors.js';
import type { ConfigureGovernanceInput } from '../governance.types.js';

export async function readGovernanceSettings(
  client: PoolClient,
  workspaceId: string,
): Promise<GovernanceSettings> {
  const [row] = await drizzle(client)
    .select({
      revision: workspaces.governanceRevision,
      auditRetentionDays: workspaces.auditRetentionDays,
      requirePublishApproval: workspaces.requirePublishApproval,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new GovernanceError(
      'conflict',
      'Workspace settings are unavailable.',
    );
  return row;
}

/** The new revision, or undefined when the expected revision is stale. */
export async function updateGovernanceSettings(
  client: PoolClient,
  input: ConfigureGovernanceInput,
): Promise<Readonly<{ revision: number }> | undefined> {
  const [row] = await drizzle(client)
    .update(workspaces)
    .set({
      auditRetentionDays: input.auditRetentionDays,
      requirePublishApproval: input.requirePublishApproval,
      governanceRevision: sql`${workspaces.governanceRevision}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workspaces.id, input.workspaceId),
        eq(workspaces.governanceRevision, input.expectedRevision),
      ),
    )
    .returning({ revision: workspaces.governanceRevision })
    .catch(rethrowQueryFailure);
  return row;
}

export async function hasAnotherManager(
  client: PoolClient,
  { workspaceId, actorId }: ConfigureGovernanceInput,
): Promise<boolean> {
  const reviewers = await drizzle(client)
    .select({ id: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        ne(workspaceMemberships.userId, actorId),
        eq(workspaceMemberships.status, 'active'),
        eq(users.status, 'active'),
        inArray(workspaceMemberships.role, [
          ...rolesForCapability('governance:manage'),
        ]),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return reviewers.length > 0;
}

/** A review asked for under the old rule no longer decides anything. */
export async function invalidatePendingReviews(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .update(workflowPublicationRequests)
    .set({ status: 'stale' })
    .where(
      and(
        eq(workflowPublicationRequests.workspaceId, workspaceId),
        eq(workflowPublicationRequests.status, 'pending'),
      ),
    )
    .catch(rethrowQueryFailure);
}
