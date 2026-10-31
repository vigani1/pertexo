import type { Stack } from '../recovery/stack.js';

export type TokenRow = Readonly<{
  id: string;
  secret_version_id: string;
  renewable: boolean;
  access_token_expires_at: Date | null;
  issued_at: Date;
  refresh_blocked_until: Date | null;
}>;

export type StoredConnection = Readonly<{
  status: string;
  last_error_code: string | null;
  current_secret_version_id: string;
  health_revision: string;
  last_healthy_at: Date | null;
  last_health_transition_source: string | null;
}>;

export type AttemptFacts = Readonly<{
  status: string;
  safe_error_code: string | null;
  error_summary: string | null;
  executor_failure_kind: string | null;
  executor_error_kind: string | null;
  executor_possibly_dispatched: boolean | null;
  executor_retry_after_millis: number | null;
  dispatch_marked_at: Date | null;
  provider_idempotency_key: string | null;
}>;

/** What is stored, read past row security, and the changes tests make to it directly. */
export function storedFacts(stack: Stack) {
  return Object.freeze({
    async connection(id: string): Promise<StoredConnection> {
      const [row] = await stack.sql<StoredConnection>(
        `select status, last_error_code, current_secret_version_id, health_revision,
                last_healthy_at, last_health_transition_source
           from app.connections where id=$1`,
        [id],
      );
      if (row === undefined) throw new Error(`Connection ${id} is not stored`);
      return row;
    },
    async tokenRow(connectionId: string): Promise<TokenRow | undefined> {
      const [row] = await stack.sql<TokenRow>(
        `select id, secret_version_id, renewable, access_token_expires_at, issued_at,
                refresh_blocked_until
           from app.connection_oauth2_tokens where connection_id=$1`,
        [connectionId],
      );
      return row;
    },
    async pendingRows(connectionId: string): Promise<number> {
      const [row] = await stack.sql<{ count: number }>(
        `select count(*)::int as count from app.connection_oauth2_authorizations
          where connection_id=$1`,
        [connectionId],
      );
      return row?.count ?? 0;
    },
    /** Past or inside the renewal window, with a token old enough to be rejected. */
    async expireToken(
      connectionId: string,
      secondsFromNow = -60,
    ): Promise<void> {
      await stack.sql(
        `update app.connection_oauth2_tokens
            set access_token_expires_at =
                  clock_timestamp() + make_interval(secs => $2::double precision),
                issued_at = clock_timestamp() - interval '2 hours',
                refresh_blocked_until = null
          where connection_id=$1`,
        [connectionId, secondsFromNow],
      );
    },
    /** Makes a token old enough that a 401 may reject it (L13). */
    async ageToken(connectionId: string): Promise<void> {
      await stack.sql(
        `update app.connection_oauth2_tokens
            set issued_at = clock_timestamp() - interval '2 hours'
          where connection_id=$1`,
        [connectionId],
      );
    },
    async setTokenUrl(connectionId: string, tokenUrl: string): Promise<void> {
      await stack.sql(
        `update app.connection_oauth2_clients
            set settings = jsonb_set(settings, '{tokenUrl}', to_jsonb($2::text))
          where connection_id=$1`,
        [connectionId, tokenUrl],
      );
    },
    attempts(runId: string, nodeId = 'call'): Promise<readonly AttemptFacts[]> {
      return stack.sql<AttemptFacts>(
        `select a.status, a.safe_error_code, a.error_summary, a.executor_failure_kind,
                a.executor_error_kind, a.executor_possibly_dispatched,
                a.executor_retry_after_millis, a.dispatch_marked_at,
                a.provider_idempotency_key
           from app.node_attempts a
           join app.node_runs n on n.id=a.node_run_id and n.workspace_id=a.workspace_id
          where n.workflow_run_id=$1 and n.node_id=$2
          order by a.attempt_number`,
        [runId, nodeId],
      );
    },
    async storedOutput(runId: string): Promise<string> {
      const [row] = await stack.sql<{ stored: string }>(
        `select coalesce(string_agg(
                  coalesce(n.output_ref::text,'') || coalesce(a.output_ref::text,'')
                  || coalesce(a.error_summary,''), ' '), '') as stored
           from app.node_runs n
           left join app.node_attempts a
             on a.node_run_id=n.id and a.workspace_id=n.workspace_id
          where n.workflow_run_id=$1`,
        [runId],
      );
      return row?.stored ?? '';
    },
    async events(connectionId: string): Promise<readonly string[]> {
      const rows = await stack.sql<{ event_type: string }>(
        `select event_type from app.connection_events
          where connection_id=$1 order by created_at, id`,
        [connectionId],
      );
      return rows.map(({ event_type: type }) => type);
    },
  });
}
