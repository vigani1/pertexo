import type { PoolClient } from 'pg';

export type PhysicalAttemptRow = Readonly<{
  attempt_id: string | null;
  attempt_number: number | null;
  attempt_status: string | null;
  attempt_output_ref: unknown;
  executor_failure_kind: string | null;
  node_output_ref: unknown;
  invocation_key: string | null;
  node_run_id: string | null;
  current_attempt_id: string | null;
  node_status: string | null;
  resume_at: Date | null;
  retry_due_at: Date | null;
  retry_decision: string | null;
  wait_kind: 'node_wait' | 'retry_backoff' | null;
}>;

export type PersistedCoordinatorEventRow = Readonly<{
  sequence: number;
  type: string;
  payload: unknown;
  created_at: Date;
}>;

export type CoordinatorEventRow = PersistedCoordinatorEventRow &
  PhysicalAttemptRow;

const missingPhysicalAttempt: PhysicalAttemptRow = Object.freeze({
  attempt_id: null,
  attempt_number: null,
  attempt_status: null,
  attempt_output_ref: null,
  executor_failure_kind: null,
  node_output_ref: null,
  invocation_key: null,
  node_run_id: null,
  current_attempt_id: null,
  node_status: null,
  resume_at: null,
  retry_due_at: null,
  retry_decision: null,
  wait_kind: null,
});

export async function readPhysicalAttempts(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  attemptIds: readonly string[],
): Promise<ReadonlyMap<string, PhysicalAttemptRow>> {
  if (attemptIds.length === 0) return new Map();
  const result = await client.query<PhysicalAttemptRow>(
    `select attempt.id as attempt_id, attempt.attempt_number,
            attempt.status as attempt_status,
            attempt.output_ref as attempt_output_ref,
            attempt.executor_failure_kind,attempt.retry_decision,
            node.id as node_run_id, node.invocation_key,
            node.current_attempt_id, node.status as node_status,
            node.output_ref as node_output_ref,
            node.resume_at, node.retry_due_at, node.wait_kind
       from app.node_attempts attempt
       join app.node_runs node
         on node.workspace_id=attempt.workspace_id
        and node.id=attempt.node_run_id
       where attempt.workspace_id=$1
         and attempt.id=any($2::uuid[])
         and node.workflow_run_id=$3`,
    [workspaceId, attemptIds, runId],
  );
  return new Map(
    result.rows.flatMap((row) =>
      row.attempt_id === null ? [] : [[row.attempt_id, row] as const],
    ),
  );
}

export function attachPhysicalAttempts(
  events: readonly PersistedCoordinatorEventRow[],
  identitiesBySequence: ReadonlyMap<
    number,
    Readonly<{ attemptId: string; nodeRunId: string }>
  >,
  physicalByAttemptId: ReadonlyMap<string, PhysicalAttemptRow>,
): readonly CoordinatorEventRow[] {
  const rows: CoordinatorEventRow[] = [];
  for (const event of events) {
    const identity = identitiesBySequence.get(event.sequence);
    const physical =
      identity === undefined
        ? missingPhysicalAttempt
        : (physicalByAttemptId.get(identity.attemptId) ??
          missingPhysicalAttempt);
    rows.push(Object.freeze({ ...event, ...physical }));
  }
  return Object.freeze(rows);
}
