import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaceMemberships, users } from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import type {
  ApprovalAudienceInspectionRequest,
  ApprovalAudienceInspectionResponse,
} from '@pertexo/contracts';
import type { PendingTaskScope } from './contract.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import { taskAudienceSelectionSql } from './eligibility.queries.js';

/** Count the whole current audience; directory pagination and search cannot establish exclusivity. */
export async function inspectAudience(
  client: PoolClient,
  input: PendingTaskScope & ApprovalAudienceInspectionRequest,
): Promise<ApprovalAudienceInspectionResponse> {
  const member = workspaceMemberships;
  const [row] = await drizzle(client)
    .select({
      matchingMemberCount: sql<number>`count(*)::int`,
      actorMatchesAudience: sql<boolean>`coalesce(bool_or(${member.userId}=${input.actorId}::uuid),false)`,
    })
    .from(member)
    .innerJoin(
      users,
      and(eq(users.id, member.userId), eq(users.status, 'active')),
    )
    .where(
      and(
        eq(member.workspaceId, input.workspaceId),
        eq(member.status, 'active'),
        inArray(member.role, [...rolesForCapability('run:read')]),
        taskAudienceSelectionSql(
          sql`${JSON.stringify(input.audience)}::jsonb`,
          sql`${member.userId}`,
          sql`${member.role}`,
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new Error('Approval audience inspection is unavailable');
  return row;
}
