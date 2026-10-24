import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import { nodeRuns, workflowRuns } from '../../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import {
  readPendingTaskAllowance,
  hasPendingTaskCapacity,
} from './allowance.queries.js';
import { bindCallbackTask } from '../callbacks/bind.repository.js';
import { callbackScopeHash } from '../callbacks/identity.repository.js';
import type { PoolClient } from 'pg';
import type { RunTransitionPlan } from '../../advance/plan.js';
import { terminalRunStatuses } from '../../advance/plan.js';
import { CoordinatorRunStateCorruptError } from '../../state-errors.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { wakeWorkflowRun } from '../../calls/wakeup.repository.js';

/** The validated declaration, logical wait and checkpoint share this transaction. */
export async function persistTaskIntents(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: RunTransitionPlan;
  }>,
): Promise<void> {
  const { workspaceId, runId, plan } = input;
  if ((plan.taskIntents?.length ?? 0) === 0) return;
  await drizzle(client)
    .execute(sql`select app.lock_workspace_execution_counter(${workspaceId})`)
    .catch(rethrowQueryFailure);
  for (const intent of plan.taskIntents ?? []) {
    let status: 'canceled' | 'pending' | 'refused';
    if (terminalRunStatuses.has(plan.checkpoint.runStatus)) status = 'canceled';
    else if (intent.kind === 'callback') status = 'pending';
    else
      status = hasPendingTaskCapacity(
        await readPendingTaskAllowance(client, workspaceId),
      )
        ? 'pending'
        : 'refused';
    const row =
      intent.kind === 'callback'
        ? await bindCallbackTask(client, workspaceId, {
            runId,
            intent,
            closed: terminalRunStatuses.has(plan.checkpoint.runStatus),
          })
        : await insertDeclaredTask(client, {
            workspaceId,
            runId,
            intent,
            status,
          });
    if (row === undefined) throw new CoordinatorRunStateCorruptError();
    const n = nodeRuns;
    const wait = await drizzle(client)
      .update(n)
      .set({
        status: 'waiting',
        controlKind: 'human_task',
        outputRef: null,
        completedAt: null,
        resumeAt: row.expires_at,
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
    if (status === 'refused' || row.status === 'submitted')
      await wakeWorkflowRun(client, workspaceId, runId);
  }
}

/** Project the task result, then close every task its logical node has settled. */
export async function persistConsumedTasks(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  plan: RunTransitionPlan,
): Promise<void> {
  const completed = new Set(
    plan.events.flatMap(({ name, invocationKey }) =>
      name === 'node.succeeded' && invocationKey !== undefined
        ? [invocationKey]
        : [],
    ),
  );
  for (const node of [
    ...plan.checkpoint.invocations,
    ...(plan.prunedInvocations ?? []),
  ]) {
    if (node.output?.kind !== 'task' || !completed.has(node.invocationKey))
      continue;
    const n = nodeRuns,
      t = pendingRunTasks;
    const updated = await drizzle(client)
      .update(n)
      .set({ outputRef: t.outputRef })
      .from(t)
      .where(
        and(
          eq(t.workspaceId, workspaceId),
          eq(t.runId, runId),
          eq(t.id, node.output.taskId),
          eq(t.invocationKey, node.invocationKey),
          inArray(t.status, ['approved', 'rejected', 'submitted']),
          sql`${t.outputRef} is not null`,
          eq(n.workspaceId, t.workspaceId),
          eq(n.id, t.nodeRunId),
          eq(n.workflowRunId, t.runId),
          eq(n.invocationKey, t.invocationKey),
          eq(n.status, 'succeeded'),
        ),
      )
      .catch(rethrowQueryFailure);
    if (updated.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
  if (terminalRunStatuses.has(plan.checkpoint.runStatus)) {
    await closeUnboundCallbacks(client, { workspaceId, runId });
  } else {
    const closed = [
      ...plan.checkpoint.invocations,
      ...(plan.prunedInvocations ?? []),
    ].filter((node) =>
      [
        'skipped',
        'canceled',
        'failed',
        'timed_out',
        'outcome_unknown',
      ].includes(node.status),
    );
    if (closed.length > 0) {
      const t = pendingRunTasks;
      // The callback-kind CHECK requires both immutable scope-identity fields.
      const prepared = await drizzle(client)
        .select({
          id: t.id,
          callback_node_id: sql<string>`${t.callbackNodeId}`,
          callback_scope_hash: sql<string>`${t.callbackScopeHash}`,
        })
        .from(t)
        .where(
          and(
            eq(t.workspaceId, workspaceId),
            eq(t.runId, runId),
            eq(t.kind, 'callback'),
            isNull(t.nodeRunId),
            isNull(t.consumedAt),
          ),
        )
        .catch(rethrowQueryFailure);
      if (prepared.length > 0) {
        const scopes = new Set(
          closed.map(
            (node) =>
              `${node.nodeId}:${callbackScopeHash(node.iterationPath ?? [])}`,
          ),
        );
        const ids = prepared
          .filter((task) =>
            scopes.has(`${task.callback_node_id}:${task.callback_scope_hash}`),
          )
          .map((task) => task.id);
        if (ids.length > 0)
          await closeUnboundCallbacks(client, { workspaceId, runId, ids });
      }
    }
  }
  const t = pendingRunTasks,
    n = nodeRuns;
  await drizzle(client)
    .update(t)
    .set({
      status: sql`case when ${t.status}='pending' then 'canceled' else ${t.status} end`,
      completedAt: sql`coalesce(${t.completedAt},clock_timestamp())`,
      consumedAt: sql`coalesce(${t.consumedAt},clock_timestamp())`,
    })
    .from(n)
    .where(
      and(
        eq(t.workspaceId, workspaceId),
        eq(t.runId, runId),
        eq(n.workspaceId, t.workspaceId),
        eq(n.id, t.nodeRunId),
        eq(n.workflowRunId, t.runId),
        notInArray(n.status, ['pending', 'ready', 'running', 'waiting']),
        isNull(t.consumedAt),
      ),
    )
    .catch(rethrowQueryFailure);
}

function closeUnboundCallbacks(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    ids?: readonly string[];
  }>,
) {
  const t = pendingRunTasks;
  return drizzle(client)
    .update(t)
    .set({
      status: sql`case when ${t.status}='prepared' then 'canceled' else ${t.status} end`,
      completedAt: sql`coalesce(${t.completedAt},clock_timestamp())`,
      consumedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(t.workspaceId, input.workspaceId),
        eq(t.runId, input.runId),
        input.ids === undefined
          ? eq(t.kind, 'callback')
          : inArray(t.id, [...input.ids]),
        isNull(t.nodeRunId),
        isNull(t.consumedAt),
      ),
    )
    .catch(rethrowQueryFailure);
}
async function insertDeclaredTask(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    intent: Exclude<
      NonNullable<RunTransitionPlan['taskIntents']>[number],
      { kind: 'callback' }
    >;
    status: 'canceled' | 'pending' | 'refused';
  }>,
) {
  const { workspaceId, runId, intent, status } = input;
  const db = drizzle(client),
    n = nodeRuns,
    r = workflowRuns;
  const declaration = db
    .select({
      id: sql<string>`${generatePersistedId()}::uuid`.as('id'),
      workspaceId: sql<string>`${workspaceId}::uuid`.as('workspace_id'),
      runId: sql<string>`${runId}::uuid`.as('run_id'),
      workflowVersionId: r.workflowVersionId,
      nodeRunId: n.id,
      callbackNodeId: sql`null`.as('callback_node_id'),
      callbackScope: sql`null`.as('callback_scope'),
      callbackScopeHash: sql`null`.as('callback_scope_hash'),
      callbackTokenHash: sql`null`.as('callback_token_hash'),
      callbackKeyVersion: sql`null`.as('callback_key_version'),
      openedAt: sql`null`.as('opened_at'),
      invocationKey: sql<string>`${intent.invocationKey}::varchar`.as(
        'invocation_key',
      ),
      kind: sql<string>`${intent.kind}::varchar`.as('kind'),
      config: sql`${JSON.stringify(intent.config)}::jsonb`.as('config'),
      context: sql`${JSON.stringify(intent.context ?? {})}::jsonb`.as(
        'context',
      ),
      status: sql<string>`${status}::varchar`.as('status'),
      outputRef: sql`null`.as('output_ref'),
      decidedBy: sql`null`.as('decided_by'),
      createdAt: sql<Date>`observed.time`.as('created_at'),
      expiresAt:
        sql<Date>`observed.time+make_interval(secs=>${intent.config.expiresAfterSeconds})`.as(
          'expires_at',
        ),
      completedAt:
        sql<Date | null>`case when ${status}::varchar='pending' then null else observed.time end`.as(
          'completed_at',
        ),
      consumedAt: sql`null`.as('consumed_at'),
    })
    .from(r)
    .innerJoin(
      n,
      and(eq(n.workspaceId, r.workspaceId), eq(n.workflowRunId, r.id)),
    )
    .crossJoin(sql`(select clock_timestamp() time) observed`)
    .where(
      and(
        eq(r.workspaceId, workspaceId),
        eq(r.id, runId),
        eq(n.invocationKey, intent.invocationKey),
        eq(n.status, 'succeeded'),
      ),
    );
  // A successful declaration initializes the expiry in this statement.
  const [row] = await db
    .insert(pendingRunTasks)
    .select(declaration)
    .returning({
      id: pendingRunTasks.id,
      expires_at: sql<Date>`${pendingRunTasks.expiresAt}`.mapWith(
        pendingRunTasks.expiresAt,
      ),
      status: pendingRunTasks.status,
    })
    .catch(rethrowQueryFailure);
  return row;
}
