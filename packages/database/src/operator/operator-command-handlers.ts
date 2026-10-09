import { sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../outbox/events.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import { requestWorkflowRunCancellation } from '../runs/commands/cancel.js';
import { appendLockedRunEvent, RUN_EVENT_TYPE } from '../runs/events.js';
import {
  operatorRunReplayRequests,
  operatorUnknownOutcomeEvidence,
} from '../schema/operator.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';

/**
 * What a command did: its outcome, its stored result, whether it waits on a
 * worker, and facts its audit event records beyond the request.
 */
export type OperatorDecision = Readonly<{
  outcome: string;
  result: Readonly<Record<string, unknown>>;
  pending?: boolean;
  auditMetadata?: Readonly<Record<string, unknown>>;
}>;

const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
/** Due nodes one resume marks; the result says when more remain. */
const RESUME_PAGE = 100;

function withoutNulls(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) => entry !== null && entry !== undefined,
    ),
  );
}

async function enqueue(
  transaction: WorkspaceTransaction,
  job: Readonly<{
    jobName: string;
    aggregateType: string;
    aggregateId: string;
    fields: Readonly<Record<string, string>>;
  }>,
): Promise<string> {
  const id = generatePersistedId();
  const payload = {
    ...job.fields,
    outboxEventId: id,
    schemaVersion: 1,
    workspaceId: transaction.workspaceId,
  };
  await insertOutboxEvent(transaction, {
    id,
    jobName: job.jobName,
    schemaVersion: 1,
    aggregateType: job.aggregateType,
    aggregateId: job.aggregateId,
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  });
  return id;
}

const enqueueAdvance = (
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<string> =>
  enqueue(transaction, {
    jobName: 'advance-workflow-run',
    aggregateType: 'workflow-run',
    aggregateId: runId,
    fields: { runId },
  });

const optionalDate = z
  .union([z.date(), z.string()])
  .nullable()
  .transform((value) =>
    value === null ? null : new Date(value).toISOString(),
  );
const outboxRowSchema = z.object({
  failed_at: optionalDate,
  last_error_code: z.string().nullable(),
  publish_attempts: z.coerce.number().int().nonnegative(),
  published_at: optionalDate,
});

/** Makes a failed outbox event available to the dispatcher again. */
export async function redispatchFailedOutbox(
  transaction: WorkspaceTransaction,
  input: Readonly<{ outboxEventId: string; dryRun: boolean }>,
): Promise<OperatorDecision> {
  const rows = await transaction.db.execute(sql`
    select published_at, failed_at, publish_attempts, last_error_code
    from app.outbox_events
    where workspace_id = ${transaction.workspaceId} and id = ${input.outboxEventId}
    for update
  `);
  const outbox =
    rows.rows[0] === undefined
      ? undefined
      : outboxRowSchema.parse(rows.rows[0]);
  const outcome =
    outbox === undefined
      ? 'not_found'
      : outbox.published_at !== null
        ? 'already_published'
        : outbox.failed_at === null
          ? 'not_failed'
          : input.dryRun
            ? 'would_redispatch'
            : 'redispatched';
  if (outcome === 'redispatched')
    await transaction.db.execute(sql`
      update app.outbox_events
      set available_at = clock_timestamp(), lease_owner = null, lease_token = null,
          lease_expires_at = null, publish_attempts = 0, failed_at = null,
          last_error_code = null, updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${input.outboxEventId}
    `);
  const prior = {
    priorErrorCode: outbox?.last_error_code ?? null,
    priorFailedAt: outbox?.failed_at ?? null,
    priorPublishAttempts: outbox?.publish_attempts ?? null,
  };
  return {
    outcome,
    result: { schemaVersion: 1, outcome, ...prior },
    auditMetadata: prior,
  };
}

const attemptRowSchema = z.object({
  dispatch_marked_at: z.unknown(),
  fence_token: z.coerce.number().int(),
  lease_expired: z.boolean().nullable(),
  node_run_id: z.uuid(),
  run_id: z.uuid(),
  side_effect_class: z.string(),
  status: z.string(),
});

/**
 * Settles a running attempt whose lease expired: either back to ready for
 * another worker (never once an unsafe side effect may have been dispatched)
 * or to an unknown outcome the run then advances past.
 */
export async function reconcileAttempt(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    commandId: string;
    attemptId: string;
    expectedFenceToken: number;
    action: 'reclaim' | 'outcome_unknown';
    dryRun: boolean;
  }>,
): Promise<OperatorDecision> {
  const { attemptId, action, expectedFenceToken: fence } = input;
  // The run lock comes first, as it does for every run writer.
  await transaction.db.execute(sql`
    select 1 from app.workflow_runs
    where workspace_id = ${transaction.workspaceId}
      and id = (select node.workflow_run_id from app.node_attempts attempt
        join app.node_runs node on node.workspace_id = attempt.workspace_id
          and node.id = attempt.node_run_id
        where attempt.workspace_id = ${transaction.workspaceId}
          and attempt.id = ${attemptId})
    for update
  `);
  const rows = await transaction.db.execute(sql`
    select attempt.status, attempt.fence_token, attempt.dispatch_marked_at,
      attempt.side_effect_class, node.id node_run_id, node.workflow_run_id run_id,
      attempt.lease_expires_at <= clock_timestamp() lease_expired
    from app.node_attempts attempt
    join app.node_runs node on node.workspace_id = attempt.workspace_id
      and node.id = attempt.node_run_id
    where attempt.workspace_id = ${transaction.workspaceId} and attempt.id = ${attemptId}
    for update of attempt, node
  `);
  const attempt =
    rows.rows[0] === undefined
      ? undefined
      : attemptRowSchema.parse(rows.rows[0]);
  const outcome =
    attempt === undefined
      ? 'not_found'
      : attempt.status !== 'running'
        ? 'not_running'
        : attempt.fence_token !== fence
          ? 'fence_conflict'
          : attempt.lease_expired !== true
            ? 'lease_active'
            : action === 'reclaim' &&
                attempt.dispatch_marked_at !== null &&
                attempt.side_effect_class === 'unsafe'
              ? 'reclaim_unsafe'
              : input.dryRun
                ? action === 'reclaim'
                  ? 'would_reclaim'
                  : 'would_mark_unknown'
                : action === 'reclaim'
                  ? 'reclaimed'
                  : 'marked_unknown';

  let outboxEventId: string | undefined;
  if (attempt !== undefined && outcome === 'reclaimed') {
    await transaction.db.execute(sql`
      update app.node_attempts
      set status = 'ready', fence_token = ${fence + 1}, lease_owner = null,
          lease_expires_at = null, completed_at = null, updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${attemptId}
    `);
    const node = await transaction.db.execute(sql`
      update app.node_runs
      set status = 'ready', updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${attempt.node_run_id}
        and current_attempt_id = ${attemptId} and status = 'running'
    `);
    if (node.rowCount !== 1)
      throw new Error('Reclaimed attempt does not own a running node');
    outboxEventId = await enqueue(transaction, {
      jobName: 'execute-node-attempt',
      aggregateType: 'node-attempt',
      aggregateId: attemptId,
      fields: {
        attemptId,
        nodeRunId: attempt.node_run_id,
        runId: attempt.run_id,
      },
    });
  } else if (attempt !== undefined && outcome === 'marked_unknown') {
    await transaction.db.execute(sql`
      update app.node_attempts
      set status = 'outcome_unknown', fence_token = ${fence + 1}, lease_owner = null,
          lease_expires_at = null,
          reconciliation_ref = jsonb_build_object('operatorCommandId', ${input.commandId}::uuid),
          completed_at = clock_timestamp(), updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${attemptId}
    `);
    await transaction.db.execute(sql`
      update app.node_runs
      set status = 'outcome_unknown', completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${attempt.node_run_id}
        and current_attempt_id = ${attemptId}
    `);
    await appendLockedRunEvent(transaction, attempt.run_id, {
      type: RUN_EVENT_TYPE.nodeOutcomeUnknown,
      payload: {
        attemptId,
        nodeRunId: attempt.node_run_id,
        operatorCommandId: input.commandId,
        reconciliation: true,
      },
    });
    outboxEventId = await enqueueAdvance(transaction, attempt.run_id);
  }
  const changed = outcome === 'reclaimed' || outcome === 'marked_unknown';
  return {
    outcome,
    result: withoutNulls({
      schemaVersion: 1,
      action,
      fenceToken: changed ? fence + 1 : fence,
      outboxEventId,
      outcome,
    }),
  };
}

const dueStateSchema = z.object({
  due_nodes: z.coerce.number().int().nonnegative(),
  due_wait: z.boolean(),
});

/**
 * Wakes a run's due node retries and resumes, one page at a time, and its
 * due workflow wait, then asks the run to advance.
 */
export async function resumeDueWork(
  transaction: WorkspaceTransaction,
  input: Readonly<{ runId: string; dryRun: boolean }>,
): Promise<OperatorDecision> {
  const { runId } = input;
  const runs = await transaction.db.execute<{ status: string }>(sql`
    select status from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${runId}
    for update
  `);
  const run = runs.rows[0];
  if (run === undefined)
    return {
      outcome: 'not_found',
      result: {
        schemaVersion: 1,
        dueNodeCount: 0,
        dueWorkflowWait: false,
        outcome: 'not_found',
      },
    };
  const rows = await transaction.db.execute(sql`
    select
      (select count(*) from (
        select 1 from app.node_runs
        where workspace_id = ${transaction.workspaceId} and workflow_run_id = ${runId}
          and status = 'waiting' and coalesce(retry_due_at, resume_at) <= clock_timestamp()
          and due_wakeup_at is distinct from coalesce(retry_due_at, resume_at)
        limit ${RESUME_PAGE + 1}) due) due_nodes,
      exists(select 1 from app.run_checkpoints
        where workspace_id = ${transaction.workspaceId} and workflow_run_id = ${runId}
          and resume_at <= clock_timestamp()
          and (resume_lease_expires_at is null
            or resume_lease_expires_at <= clock_timestamp())) due_wait
  `);
  const state = dueStateSchema.parse(rows.rows[0]);
  const dueNodeCount = Math.min(state.due_nodes, RESUME_PAGE);
  const outcome = TERMINAL_RUN_STATUSES.has(run.status)
    ? 'terminal'
    : dueNodeCount === 0 && !state.due_wait
      ? 'not_due'
      : input.dryRun
        ? 'would_resume'
        : 'resumed';

  let outboxEventId: string | undefined;
  if (outcome === 'resumed') {
    await transaction.db.execute(sql`
      with due as (
        select id from app.node_runs
        where workspace_id = ${transaction.workspaceId} and workflow_run_id = ${runId}
          and status = 'waiting' and coalesce(retry_due_at, resume_at) <= clock_timestamp()
          and due_wakeup_at is distinct from coalesce(retry_due_at, resume_at)
        order by coalesce(retry_due_at, resume_at), id
        for update limit ${RESUME_PAGE}
      )
      update app.node_runs node
      set due_wakeup_at = coalesce(node.retry_due_at, node.resume_at),
          updated_at = clock_timestamp()
      from due
      where node.workspace_id = ${transaction.workspaceId} and node.id = due.id
    `);
    await transaction.db.execute(sql`
      update app.run_checkpoints
      set resume_at = null, resume_lease_owner = null, resume_lease_token = null,
          resume_lease_expires_at = null, updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and workflow_run_id = ${runId}
        and resume_at <= clock_timestamp()
        and (resume_lease_expires_at is null
          or resume_lease_expires_at <= clock_timestamp())
    `);
    outboxEventId = await enqueueAdvance(transaction, runId);
  }
  return {
    outcome,
    result: withoutNulls({
      schemaVersion: 1,
      dueNodeCount,
      dueNodesRemaining: state.due_nodes > RESUME_PAGE,
      dueWorkflowWait: state.due_wait,
      outboxEventId,
      outcome,
    }),
  };
}

const cancelStateSchema = z.object({
  cancel_requested: z.boolean(),
  status: z.string(),
});

/** Requests cancellation through the same path the API uses. */
export async function cancelRun(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    runId: string;
    actorRef: string;
    reason: string;
    dryRun: boolean;
  }>,
): Promise<OperatorDecision> {
  const rows = await transaction.db.execute(sql`
    select status, cancel_requested_at is not null cancel_requested
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${input.runId}
    for update
  `);
  const run =
    rows.rows[0] === undefined
      ? undefined
      : cancelStateSchema.parse(rows.rows[0]);
  const outcome =
    run === undefined
      ? 'not_found'
      : TERMINAL_RUN_STATUSES.has(run.status)
        ? 'terminal'
        : run.cancel_requested
          ? 'already_requested'
          : input.dryRun
            ? 'would_cancel'
            : 'cancel_requested';

  let eventSequence: number | null = null;
  let outboxEventId: string | undefined;
  if (outcome === 'cancel_requested') {
    ({ eventSequence } = await requestWorkflowRunCancellation(transaction, {
      actor: input.actorRef,
      reason: input.reason,
      runId: input.runId,
    }));
    outboxEventId = await enqueueAdvance(transaction, input.runId);
  }
  return {
    outcome,
    result: withoutNulls({
      schemaVersion: 1,
      eventSequence,
      outboxEventId,
      outcome,
    }),
  };
}

/** Records what an operator learned about an unknown outcome and asks a worker to reconcile it. */
export async function recordUnknownOutcomeEvidence(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    commandId: string;
    attemptId: string;
    evidenceKind: string;
    evidenceRef: string;
  }>,
): Promise<OperatorDecision> {
  const rows = await transaction.db.execute<{ status: string }>(sql`
    select status from app.node_attempts
    where workspace_id = ${transaction.workspaceId} and id = ${input.attemptId}
    for update
  `);
  const status = rows.rows[0]?.status;
  const outcome =
    status === undefined
      ? 'not_found'
      : status !== 'outcome_unknown'
        ? 'not_unknown'
        : 'evidence_recorded';

  let outboxEventId: string | null = null;
  if (outcome === 'evidence_recorded') {
    await transaction.db.insert(operatorUnknownOutcomeEvidence).values({
      commandId: input.commandId,
      workspaceId: transaction.workspaceId,
      attemptId: input.attemptId,
      evidenceKind: input.evidenceKind,
      evidenceRef: sql`${input.evidenceRef}::jsonb`,
    });
    outboxEventId = await enqueue(transaction, {
      jobName: 'reconcile-unknown-outcome',
      aggregateType: 'node-attempt',
      aggregateId: input.attemptId,
      fields: {
        attemptId: input.attemptId,
        evidenceCommandId: input.commandId,
      },
    });
  }
  return {
    outcome,
    result: {
      schemaVersion: 1,
      evidenceKind: input.evidenceKind,
      outboxEventId,
      outcome,
    },
  };
}

/** Asks a worker to reconcile a published workflow's triggers again. */
export async function retryTriggerReconciliation(
  transaction: WorkspaceTransaction,
  input: Readonly<{ workflowId: string; dryRun: boolean }>,
): Promise<OperatorDecision> {
  const rows = await transaction.db.execute<{
    published_version_id: string | null;
  }>(sql`
    select published_version_id from app.workflows
    where workspace_id = ${transaction.workspaceId} and id = ${input.workflowId}
      and lifecycle_status = 'active'
    for share
  `);
  const workflow = rows.rows[0];
  const publishedVersionId = workflow?.published_version_id ?? null;
  const outcome =
    workflow === undefined
      ? 'not_found'
      : publishedVersionId === null
        ? 'not_published'
        : input.dryRun
          ? 'would_retry'
          : 'retry_requested';

  let outboxEventId: string | undefined;
  if (outcome === 'retry_requested' && publishedVersionId !== null)
    outboxEventId = await enqueue(transaction, {
      jobName: 'reconcile-workflow-triggers',
      aggregateType: 'workflow',
      aggregateId: input.workflowId,
      fields: { publishedVersionId, workflowId: input.workflowId },
    });
  return {
    outcome,
    result: withoutNulls({
      schemaVersion: 1,
      outboxEventId,
      outcome,
      publishedVersionId,
    }),
  };
}

/**
 * Stores a request to run a source run's workflow again on an executable
 * version of the same workflow; the replay worker creates the run.
 */
export async function requestRunReplay(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    commandId: string;
    sourceRunId: string;
    workflowVersionId: string;
    runInput: string;
    requestFingerprint: string;
    dryRun: boolean;
  }>,
): Promise<OperatorDecision> {
  const rows = await transaction.db.execute<{
    source_workflow_id: string;
    target_workflow_id: string | null;
  }>(sql`
    select run.workflow_id source_workflow_id,
      (select version.workflow_id from app.workflow_versions version
        where version.workspace_id = run.workspace_id
          and version.id = ${input.workflowVersionId}
          and version.executable_json is not null) target_workflow_id
    from app.workflow_runs run
    where run.workspace_id = ${transaction.workspaceId} and run.id = ${input.sourceRunId}
  `);
  const found = rows.rows[0];
  const outcome =
    found === undefined
      ? 'source_not_found'
      : found.target_workflow_id === null
        ? 'version_not_executable'
        : found.target_workflow_id !== found.source_workflow_id
          ? 'workflow_mismatch'
          : input.dryRun
            ? 'would_request'
            : 'replay_requested';

  let outboxEventId: string | undefined;
  if (found !== undefined && outcome === 'replay_requested') {
    await transaction.db.insert(operatorRunReplayRequests).values({
      commandId: input.commandId,
      workspaceId: transaction.workspaceId,
      sourceRunId: input.sourceRunId,
      workflowId: found.source_workflow_id,
      workflowVersionId: input.workflowVersionId,
      runInput: sql`${input.runInput}::jsonb`,
      requestFingerprint: input.requestFingerprint,
    });
    outboxEventId = await enqueue(transaction, {
      jobName: 'replay-workflow-run',
      aggregateType: 'operator-command',
      aggregateId: input.commandId,
      fields: { commandId: input.commandId },
    });
  }
  return {
    outcome,
    pending: outcome === 'replay_requested',
    result: withoutNulls({
      schemaVersion: 1,
      outboxEventId,
      outcome,
      sourceRunId: input.sourceRunId,
      workflowVersionId: input.workflowVersionId,
    }),
  };
}
