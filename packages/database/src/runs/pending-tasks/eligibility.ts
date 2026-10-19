/**
 * Captured role-or-member selection is shared by tasks and prospective
 * authoring checks. A missing audience selects nobody: comparing against it
 * yields null, which would otherwise let "not in the audience" pass.
 */
export function taskAudienceSelectionSql(
  audienceExpression: string,
  actorExpression: string,
  roleExpression: string,
): string {
  return `coalesce(((${audienceExpression})->'roles') ? (${roleExpression})::text OR ((${audienceExpression})->'memberIds') ? (${actorExpression})::text, false)`;
}
function starterExcludedSql(actorExpression: string): string {
  return `task.kind='approval' and task.config->'allowStarterToDecide' is distinct from 'true'::jsonb and run.started_by is not distinct from (${actorExpression})::uuid`;
}
/** The captured choice and audience serve discovery, notices and decisions. */
export function pendingTaskAudienceSql(
  actorParameter: string,
  roleParameter: string,
): string {
  return `(${taskAudienceSelectionSql("task.config->'audience'", actorParameter, roleParameter)}) and not (${starterExcludedSql(actorParameter)})`;
}
/** Current task/run state also gates Inbox context and mail, without copying its rules. */
export function pendingTaskBlockedSql(
  actorParameter: string,
  roleParameter: string,
): string {
  // A canceled task closed with its run; nobody resolved it.
  return `case when task.status='expired' then 'expired' when task.status='canceled' then 'run_closed' when task.status <> 'pending' then 'resolved'
    when run.status not in ('queued','running','waiting') or run.cancel_requested_at is not null or run.deadline_at<=clock_timestamp() then 'run_closed'
    when task.expires_at <= clock_timestamp() then 'expired'
    when ${starterExcludedSql(actorParameter)} then 'starter'
    when not ${taskAudienceSelectionSql("task.config->'audience'", actorParameter, roleParameter)} then 'audience' else null end`;
}
