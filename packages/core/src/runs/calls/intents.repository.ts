import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import {
  workflowVersions,
  nodeRuns,
  nodeAttempts,
  workflowRuns,
  workflowCalls,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WorkflowCallIntent } from '@pertexo/workflow-engine';
import {
  generatePersistedId,
  prepareStoredExecutionValue,
  STORED_EXECUTION_VALUE_LIMITS,
} from '@pertexo/database/platform';
import { CoordinatorRunStateCorruptError } from '../state-errors.js';
import {
  terminalRunStatuses,
  type RunTransitionPlan,
} from '../advance/plan.js';

async function preparedInput(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  intent: WorkflowCallIntent,
): Promise<
  Readonly<{ json: string | null; checksum: string; refusal?: string }>
> {
  const n = nodeRuns,
    a = nodeAttempts;
  const [row] = await drizzle(client)
    .select({ id: a.id, output_ref: a.outputRef })
    .from(n)
    .innerJoin(
      a,
      and(
        eq(a.workspaceId, n.workspaceId),
        eq(a.nodeRunId, n.id),
        eq(a.id, n.currentAttemptId),
        eq(a.attemptNumber, n.currentAttemptNumber),
      ),
    )
    .where(
      and(
        eq(n.workspaceId, workspaceId),
        eq(n.workflowRunId, runId),
        eq(n.invocationKey, intent.invocationKey),
        eq(n.status, 'succeeded'),
        eq(a.status, 'succeeded'),
        sql`${n.outputRef}::jsonb=${a.outputRef}::jsonb`,
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new CoordinatorRunStateCorruptError();
  const prepared = prepareStoredExecutionValue(row.output_ref);
  const inputMismatch =
    (intent.input.kind === 'inline' &&
      (intent.input.attemptId !== row.id ||
        prepared.value.kind !== 'inline')) ||
    (intent.input.kind === 'artifact' &&
      (prepared.value.kind !== 'artifact' ||
        intent.input.artifactId !== prepared.value.artifactId));
  if (inputMismatch) throw new CoordinatorRunStateCorruptError();
  const checksum = createHash('sha256').update(prepared.json).digest('hex');
  const refusal = callInputRefusal(prepared);
  return {
    json: refusal === undefined ? prepared.json : null,
    checksum,
    ...(refusal === undefined ? {} : { refusal }),
  };
}

/** Intent, wait and wakeup are saved in the parent's checkpoint transaction. */
export async function persistCallIntents(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: RunTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  const { workspaceId, runId, plan } = input;
  const closed = terminalRunStatuses.has(plan.checkpoint.runStatus);
  for (const intent of plan.callIntents ?? []) {
    const prepared = await preparedInput(client, workspaceId, runId, intent);
    const refusal = closed ? 'call_parent_closed' : prepared.refusal;
    const result = await insertCallIntent(client, {
      workspaceId,
      runId,
      intent,
      prepared,
      refusal,
    });
    if (result.length !== 1) throw new CoordinatorRunStateCorruptError();
    // A declaration may settle in the same transition as parent cancellation.
    // The ordinary event writer still requires a waiting logical node first.
    const n = nodeRuns;
    const wait = await drizzle(client)
      .update(n)
      .set({
        status: 'waiting',
        controlKind: 'workflow_call',
        outputRef: null,
        completedAt: null,
        resumeAt: null,
        retryDueAt: null,
        dueWakeupAt: null,
        waitKind: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(n.workspaceId, workspaceId),
          eq(n.workflowRunId, runId),
          eq(n.invocationKey, intent.invocationKey),
          eq(n.status, 'succeeded'),
        ),
      )
      .catch(rethrowQueryFailure);
    if (wait.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
}

function callInputRefusal(
  prepared: ReturnType<typeof prepareStoredExecutionValue>,
): string | undefined {
  if (prepared.value.kind === 'artifact') {
    return 'call_input_artifact_unsupported';
  }
  if (
    utf8ByteLength(prepared.json) > STORED_EXECUTION_VALUE_LIMITS.inlineBytes
  ) {
    return 'call_input_too_large';
  }
  return undefined;
}

function insertCallIntent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    intent: WorkflowCallIntent;
    prepared: Awaited<ReturnType<typeof preparedInput>>;
    refusal: string | undefined;
  }>,
) {
  const { workspaceId, runId, intent, prepared, refusal } = input;
  const db = drizzle(client),
    r = workflowRuns,
    v = workflowVersions,
    c = workflowCalls;
  const declaration = db
    .select({
      id: sql<string>`${generatePersistedId()}::uuid`.as('id'),
      workspaceId: sql<string>`${workspaceId}::uuid`.as('workspace_id'),
      parentRunId: sql<string>`${runId}::uuid`.as('parent_run_id'),
      invocationKey: sql<string>`${intent.invocationKey}`.as('invocation_key'),
      targetWorkflowId: sql<string>`${intent.target.workflowId}::uuid`.as(
        'target_workflow_id',
      ),
      targetVersionId: sql<string>`${intent.target.workflowVersionId}::uuid`.as(
        'target_version_id',
      ),
      targetChecksum:
        sql<string>`${intent.target.executableChecksum}::varchar`.as(
          'target_checksum',
        ),
      inputRef: sql`${prepared.json}::json`.as('input_ref'),
      inputChecksum: sql<string>`${prepared.checksum}`.as('input_checksum'),
      deadlineAt:
        sql<Date | null>`least(${r.deadlineAt},clock_timestamp()+(${v.executableJson}#>>'{graph,settings,maxRunDurationMs}')::integer*interval '1 millisecond')`.as(
          'deadline_at',
        ),
      status: sql<string>`${refusal === undefined ? 'pending' : 'refused'}`.as(
        'status',
      ),
      childRunId: sql`null`.as('child_run_id'),
      liveChildRunId: sql`null`.as('live_child_run_id'),
      resultRef: sql`null`.as('result_ref'),
      safeErrorCode: sql<string | null>`${refusal ?? null}::varchar`.as(
        'safe_error_code',
      ),
      slotLent: sql<boolean>`false`.as('slot_lent'),
      consumedAt: sql`null`.as('consumed_at'),
      detailsPurgedAt: sql`null`.as('details_purged_at'),
      cancelRequestedAt: sql`null`.as('cancel_requested_at'),
      cancelAppliedAt: sql`null`.as('cancel_applied_at'),
      createdAt: sql<Date>`clock_timestamp()`.as('created_at'),
      completedAt:
        sql<Date | null>`case when ${refusal ?? null}::varchar is null then null else clock_timestamp() end`.as(
          'completed_at',
        ),
    })
    .from(r)
    .innerJoin(
      v,
      and(
        eq(v.workspaceId, r.workspaceId),
        eq(v.workflowId, intent.target.workflowId),
        eq(v.id, intent.target.workflowVersionId),
      ),
    )
    .where(
      and(
        eq(r.workspaceId, workspaceId),
        eq(r.id, runId),
        eq(v.checksum, intent.target.executableChecksum),
      ),
    );
  return db
    .insert(c)
    .select(declaration)
    .onConflictDoNothing({
      target: [c.workspaceId, c.parentRunId, c.invocationKey],
    })
    .returning({ id: c.id })
    .catch(rethrowQueryFailure);
}
