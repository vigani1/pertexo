import { sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  workspaces,
  pendingRunTasks,
  workflowRuns,
} from '@pertexo/database/schema';
export const task = alias(pendingRunTasks, 'task');
export const run = alias(workflowRuns, 'run');
/** A missing captured audience selects nobody. */
export function taskAudienceSelectionSql(
  audience: SQL,
  actor: SQL,
  role: SQL,
): SQL {
  return sql`coalesce(((${audience})->'roles') ? (${role})::text OR ((${audience})->'memberIds') ? (${actor})::text, false)`;
}
function starterExcludedSql(actor: SQL): SQL {
  return sql`${task.kind}='approval' and ${task.config}->'allowStarterToDecide' is distinct from 'true'::jsonb and ${run.startedBy} is not distinct from (${actor})::uuid`;
}
/** The captured choice and audience serve discovery, notices and decisions. */
export function pendingTaskAudienceSql(actor: SQL, role: SQL): SQL {
  return sql`(${taskAudienceSelectionSql(sql`${task.config}->'audience'`, actor, role)}) and not (${starterExcludedSql(actor)})`;
}
/** Current task/run state also gates Inbox context and mail. */
export function pendingTaskBlockedSql(actor: SQL, role: SQL): SQL {
  return sql`case when ${task.status}='expired' then 'expired' when ${task.status}='canceled' then 'run_closed' when ${task.status} <> 'pending' then 'resolved'
 when (select ${workspaces.status} from ${workspaces} where ${workspaces.id}=${task.workspaceId})<>'active' then 'workspace_suspended'
 when ${run.status} not in ('queued','running','waiting') or ${run.cancelRequestedAt} is not null or ${run.deadlineAt}<=clock_timestamp() then 'run_closed'
 when ${task.expiresAt} <= clock_timestamp() then 'expired'
 when ${starterExcludedSql(actor)} then 'starter'
 when not ${taskAudienceSelectionSql(sql`${task.config}->'audience'`, actor, role)} then 'audience' else null end`;
}
