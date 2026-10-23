import type { PoolClient } from 'pg';
import type {
  ApprovalAudienceInspectionRequest,
  ApprovalAudienceInspectionResponse,
} from '@pertexo/contracts';
import type { PendingTaskScope } from './contract.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import { taskAudienceSelectionSql } from './eligibility.js';

/** Count the whole current audience; directory pagination and search cannot establish exclusivity. */
export async function inspectAudience(
  client: PoolClient,
  input: PendingTaskScope & ApprovalAudienceInspectionRequest,
): Promise<ApprovalAudienceInspectionResponse> {
  const found = await client.query<ApprovalAudienceInspectionResponse>(
    `select count(*)::int "matchingMemberCount",coalesce(bool_or(member.user_id=$2::uuid),false) "actorMatchesAudience"
      from app.workspace_memberships member join app.users actor on actor.id=member.user_id and actor.status='active'
      where member.workspace_id=$1 and member.status='active' and member.role=any($3::text[])
        and ${taskAudienceSelectionSql('$4::jsonb', 'member.user_id', 'member.role')}`,
    [
      input.workspaceId,
      input.actorId,
      rolesForCapability('run:read'),
      JSON.stringify(input.audience),
    ],
  );
  const row = found.rows[0];
  if (row === undefined)
    throw new Error('Approval audience inspection is unavailable');
  return row;
}
