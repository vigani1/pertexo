// One eligibility predicate serves discovery, detail and the locked command.
export const taskAudienceSql = `((task.config->'audience'->'roles') ? $3::text OR (task.config->'audience'->'memberIds') ? $2::text)`;
export const taskBlockedReasonSql = `case when task.status='expired' then 'expired' when task.status <> 'pending' then 'resolved'
  when run.status not in ('queued','running','waiting') or run.cancel_requested_at is not null or run.deadline_at<=clock_timestamp() then 'run_closed'
  when task.expires_at <= clock_timestamp() then 'expired'
  when task.kind='approval' and run.started_by=$2::uuid then 'starter'
  when not ${taskAudienceSql} then 'audience' else null end`;
export function pendingTaskBlockedSql(
  actorParameter: string,
  roleParameter: string,
): string {
  return taskBlockedReasonSql
    .replaceAll('$2', actorParameter)
    .replaceAll('$3', roleParameter);
}
