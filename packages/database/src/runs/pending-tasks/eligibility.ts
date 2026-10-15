const audience = `((task.config->'audience'->'roles') ? $3::text OR (task.config->'audience'->'memberIds') ? $2::text)`;
const starterExcluded = `task.kind='approval' and run.started_by is not distinct from $2::uuid`;
const blocked = `case when task.status='expired' then 'expired' when task.status <> 'pending' then 'resolved'
  when run.status not in ('queued','running','waiting') or run.cancel_requested_at is not null or run.deadline_at<=clock_timestamp() then 'run_closed'
  when task.expires_at <= clock_timestamp() then 'expired'
  when ${starterExcluded} then 'starter'
  when not ${audience} then 'audience' else null end`;
function bind(
  statement: string,
  actorParameter: string,
  roleParameter: string,
): string {
  return statement
    .replaceAll('$2', actorParameter)
    .replaceAll('$3', roleParameter);
}
/** The same captured audience and starter rule serves discovery and decisions. */
export function pendingTaskAudienceSql(
  actorParameter: string,
  roleParameter: string,
): string {
  return bind(
    `(${audience}) and not (${starterExcluded})`,
    actorParameter,
    roleParameter,
  );
}
/** Current task/run state also gates Inbox context and mail, without copying its rules. */
export function pendingTaskBlockedSql(
  actorParameter: string,
  roleParameter: string,
): string {
  return bind(blocked, actorParameter, roleParameter);
}
