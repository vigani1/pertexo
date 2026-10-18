/** Shared F27 notice window; comment storage has its own indefinite lifetime. */
export const NOTICE_WINDOW_SQL = "interval '720 hours'";

/** Mentions expire even if the attention observer was offline at the cutoff. */
export function expiredNoticeSql(alias: string): string {
  return `${alias}.latest_occurred_at <= statement_timestamp() - ${NOTICE_WINDOW_SQL} and (${alias}.notice_kind in ('workflow_failure','workflow_mention') or not ${alias}.active)`;
}
