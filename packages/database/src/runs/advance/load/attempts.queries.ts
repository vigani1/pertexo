import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import type {
  runEvents} from '../../../schema/runs/execution.js';
import {
  nodeAttempts,
  nodeRuns
} from '../../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';

type PhysicalRow = Awaited<ReturnType<typeof physicalRows>>[number];
export type PhysicalAttemptRow = Readonly<{
  [Key in keyof PhysicalRow]: PhysicalRow[Key] | null;
}>;
export type PersistedCoordinatorEventRow = Readonly<
  Pick<typeof runEvents.$inferSelect, 'sequence' | 'type' | 'payload'> & {
    created_at: typeof runEvents.$inferSelect.createdAt;
  }
>;

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
  node_id: null,
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
  const rows = await physicalRows(client, {
    workspaceId,
    runId,
    attemptIds,
  }).catch(rethrowQueryFailure);
  return new Map(rows.map((row) => [row.attempt_id, row]));
}
function physicalRows(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    attemptIds: readonly string[];
  }>,
) {
  const a = nodeAttempts,
    n = nodeRuns;
  return drizzle(client)
    .select({
      attempt_id: a.id,
      attempt_number: a.attemptNumber,
      attempt_status: a.status,
      attempt_output_ref: a.outputRef,
      executor_failure_kind: a.executorFailureKind,
      retry_decision: a.retryDecision,
      node_run_id: n.id,
      node_id: n.nodeId,
      invocation_key: n.invocationKey,
      current_attempt_id: n.currentAttemptId,
      node_status: n.status,
      node_output_ref: n.outputRef,
      resume_at: n.resumeAt,
      retry_due_at: n.retryDueAt,
      wait_kind: n.waitKind,
    })
    .from(a)
    .innerJoin(n, and(eq(n.workspaceId, a.workspaceId), eq(n.id, a.nodeRunId)))
    .where(
      and(
        eq(a.workspaceId, input.workspaceId),
        inArray(a.id, [...input.attemptIds]),
        eq(n.workflowRunId, input.runId),
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
