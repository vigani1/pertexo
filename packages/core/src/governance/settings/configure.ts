import { readGovernanceSettings } from './policy.queries.js';
import {
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
  appendAuditFact,
} from '@pertexo/database/primitives';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { and, eq, ne, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaces,
  workspaceMemberships,
  users,
  workflowPublicationRequests,
} from '@pertexo/database/schema';
import type { GovernanceSettings } from '@pertexo/contracts';
import {
  requiresPublicationReviewer,
  rolesForCapability,
} from '@pertexo/workflow-model';
import { GovernanceError, type ConfigureGovernanceInput } from '../contract.js';
export async function configureGovernance(
  client: PoolClient,
  input: ConfigureGovernanceInput,
): Promise<GovernanceSettings> {
  const db = drizzle(client);
  const identity = {
    workspaceId: input.workspaceId,
    scope: input.actorId,
    operation: 'workspace.governance.configure',
    idempotencyKey: input.idempotencyKey,
  };
  const replay = await claimCommand<GovernanceSettings>(client, {
    ...identity,
    resourceId: input.workspaceId,
    requestHash: createHash('sha256')
      .update(
        `${String(input.expectedRevision)}:${String(input.auditRetentionDays)}${input.requirePublishApproval === undefined ? '' : `:${String(input.requirePublishApproval)}`}`,
      )
      .digest('hex'),
  });
  if (replay !== null) return replay;
  const previous = await readGovernanceSettings(client, input.workspaceId);
  if (
    requiresPublicationReviewer(previous, input) &&
    !(await hasAnotherManager(client, input))
  )
    throw new GovernanceError(
      'invalid',
      'Add another active owner or admin before requiring approval to publish.',
    );
  const [row] = await db
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
  if (row === undefined)
    throw new GovernanceError(
      'conflict',
      'Governance settings changed. Reload before saving.',
    );
  const result = {
    revision: row.revision,
    auditRetentionDays: input.auditRetentionDays ?? previous.auditRetentionDays,
    requirePublishApproval:
      input.requirePublishApproval ?? previous.requirePublishApproval,
  };
  if (result.requirePublishApproval !== previous.requirePublishApproval)
    await invalidatePendingReviews(client, input.workspaceId);
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'workspace.governance_changed',
    targetType: 'workspace',
    targetId: input.workspaceId,
    metadata: result,
  });
  await completeCommand(client, identity, result);
  return result;
}

async function hasAnotherManager(
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
async function invalidatePendingReviews(
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
