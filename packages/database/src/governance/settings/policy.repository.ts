import { readGovernanceSettings } from './policy.queries.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { and, eq, ne, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaces,
  workspaceMemberships,
  users,
} from '../../schema/foundation.js';
import { workflowPublicationRequests } from '../../schema/authoring/publication-requests.js';
import type { GovernanceSettings } from '@pertexo/contracts';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { appendAuditFact } from '../audit/events.repository.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import { GovernanceError, type GovernanceStore } from '../contract.js';
export async function configureGovernance(
  client: PoolClient,
  input: Parameters<GovernanceStore['configure']>[0],
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
  const enablesPublishApproval =
    previous.revision === input.expectedRevision &&
    !previous.requirePublishApproval &&
    (input.requirePublishApproval ?? false);
  if (enablesPublishApproval) {
    const reviewers = await db
      .select({ id: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .innerJoin(users, eq(users.id, workspaceMemberships.userId))
      .where(
        and(
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          ne(workspaceMemberships.userId, input.actorId),
          eq(workspaceMemberships.status, 'active'),
          eq(users.status, 'active'),
          inArray(workspaceMemberships.role, [
            ...rolesForCapability('governance:manage'),
          ]),
        ),
      )
      .limit(1)
      .catch(rethrowQueryFailure);
    if (reviewers.length === 0)
      throw new GovernanceError(
        'invalid',
        'Add another active owner or admin before requiring approval to publish.',
      );
  }
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
    await db
      .update(workflowPublicationRequests)
      .set({ status: 'stale' })
      .where(
        and(
          eq(workflowPublicationRequests.workspaceId, input.workspaceId),
          eq(workflowPublicationRequests.status, 'pending'),
        ),
      )
      .catch(rethrowQueryFailure);
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
