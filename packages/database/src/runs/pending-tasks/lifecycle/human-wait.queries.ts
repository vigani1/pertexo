import { drizzle } from 'drizzle-orm/node-postgres';
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import {
  nodeRuns,
  runCheckpoints,
  workflowRuns,
} from '../../../schema/runs/execution.js';
import { workflowCalls } from '../../../schema/runs/calls.js';
import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';

export async function readHumanWaitFacts(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; runId: string }>,
) {
  const db = drizzle(client),
    { workspaceId, runId } = input;
  const resuming = resumeQuery(client, workspaceId);
  const resume = db.$with('resume').as(resuming);
  const joins = db
    .select({
      invocationKey: sql<string>`identity->>'joinInvocationKey'`.as(
        'join_invocation_key',
      ),
    })
    .from(runCheckpoints)
    .crossJoin(
      sql`lateral jsonb_array_elements(${runCheckpoints.schedulerState}->'joins') identity`,
    )
    .where(
      and(
        eq(runCheckpoints.workspaceId, workspaceId),
        eq(runCheckpoints.workflowRunId, runId),
      ),
    );
  const structural = db.$with('structural_joins').as(joins);
  const node = nodeRuns,
    task = pendingRunTasks,
    call = workflowCalls,
    child = alias(workflowRuns, 'child');
  const barrier = db
    .select({ key: structural.invocationKey })
    .from(structural)
    .where(eq(structural.invocationKey, node.invocationKey));
  const physicalQuery = db
    .select({
      status: node.status,
      control_kind: node.controlKind,
      wait_kind: node.waitKind,
      resume_at: node.resumeAt,
      task_status: sql<string | null>`${task.status}`.as('task_status'),
      child_wait: sql<Date | null>`${child.humanWaitStartedAt}`.as(
        'child_wait',
      ),
      slot_lent: call.slotLent,
      join_barrier:
        sql<boolean>`${node.status}='pending' and ${exists(barrier)}`.as(
          'join_barrier',
        ),
    })
    .from(node)
    .leftJoin(
      task,
      and(
        eq(task.workspaceId, node.workspaceId),
        eq(task.nodeRunId, node.id),
        eq(task.runId, node.workflowRunId),
      ),
    )
    .leftJoin(
      call,
      and(
        eq(call.workspaceId, node.workspaceId),
        eq(call.parentRunId, node.workflowRunId),
        eq(call.invocationKey, node.invocationKey),
        eq(call.status, 'accepted'),
      ),
    )
    .leftJoin(
      child,
      and(
        eq(child.workspaceId, call.workspaceId),
        eq(child.id, call.childRunId),
      ),
    )
    .where(
      and(
        eq(node.workspaceId, workspaceId),
        eq(node.workflowRunId, runId),
        inArray(node.status, ['pending', 'ready', 'running', 'waiting']),
      ),
    );
  const p = db.$with('physical').as(physicalQuery);
  const ancestor = alias(workflowRuns, 'ancestor');
  const ancestorWaiting = db
    .select({ id: ancestor.id })
    .from(sql`ancestors`)
    .innerJoin(
      ancestor,
      and(
        sql`${ancestor.id}=ancestors.id`,
        eq(ancestor.workspaceId, workspaceId),
      ),
    )
    .where(isNotNull(ancestor.humanWaitStartedAt));
  const resumeAny = db.select({ id: resume.id }).from(resume);
  const resumeChild = db
    .select({ id: resume.id })
    .from(resume)
    .where(sql`${resume.id}<>${runId}::uuid`);
  const query = db
    .select({
      all_human_waiting:
        sql<boolean>`coalesce(bool_and(coalesce(${p.join_barrier} or ${p.status}='waiting' and ((${p.control_kind}='human_task' and ${p.task_status}='pending') or ${p.control_kind}='for_each_barrier' or (${p.control_kind}='workflow_call' and ${p.child_wait} is not null)),false)),false)`.as(
          'all_human_waiting',
        ),
      has_human_wait:
        sql<boolean>`coalesce(bool_or((${p.control_kind}='human_task' and ${p.task_status}='pending') or ${p.child_wait} is not null),false)`.as(
          'has_human_wait',
        ),
      // Every remaining step waits on a timer, a person or a barrier: nothing can run yet.
      all_parked:
        sql<boolean>`coalesce(bool_and(coalesce(${p.join_barrier} or ${p.status}='waiting' and (${p.wait_kind}='node_wait' or (${p.control_kind}='human_task' and ${p.task_status}='pending') or ${p.control_kind}='for_each_barrier'),false)),false)`.as(
          'all_parked',
        ),
      has_timed_wait:
        sql<boolean>`coalesce(bool_or(${p.wait_kind}='node_wait'),false)`.as(
          'has_timed_wait',
        ),
      timer_due:
        sql<boolean>`coalesce(bool_or(${p.wait_kind} in ('node_wait','retry_backoff') and ${p.resume_at}<=clock_timestamp()),false)`.as(
          'timer_due',
        ),
      has_running_or_timed_work:
        sql<boolean>`coalesce(bool_or(${p.status}='running' or ${p.wait_kind} in ('node_wait','retry_backoff')),false)`.as(
          'has_running_or_timed_work',
        ),
      lent_human_wait:
        sql<boolean>`coalesce(bool_or(${p.slot_lent} and ${p.child_wait} is not null),false)`.as(
          'lent_human_wait',
        ),
      resume_work: sql<boolean>`${exists(resumeAny)}`.as('resume_work'),
      child_resume_work: sql<boolean>`${exists(resumeChild)}`.as(
        'child_resume_work',
      ),
      ancestor_waiting: sql<boolean>`${exists(ancestorWaiting)}`.as(
        'ancestor_waiting',
      ),
    })
    .from(p);
  const c = alias(workflowCalls, 'call');
  // Recursive ancestry is retained; the physical and aggregate reads use native builders.
  const result = await db
    .execute<(typeof query)['_']['result'][number]>(
      sql`with recursive descendants(id) as (
 select ${runId}::uuid union select ${c.childRunId} from ${workflowCalls} ${sql.identifier('call')} join descendants on ${c.parentRunId}=descendants.id where ${c.workspaceId}=${workspaceId} and ${c.status}='accepted' and ${c.childRunId} is not null
 ),ancestors(id) as (
 select ${workflowCalls.parentRunId} from ${workflowCalls} where ${workflowCalls.workspaceId}=${workspaceId} and ${workflowCalls.childRunId}=${runId} and ${workflowCalls.status}='accepted'
 union select ${c.parentRunId} from ${workflowCalls} ${sql.identifier('call')} join ancestors on ${c.childRunId}=ancestors.id where ${c.workspaceId}=${workspaceId} and ${c.status}='accepted'
 ),resume as (${resuming}),structural_joins as (${joins}),physical as (${physicalQuery}) ${query}`,
    )
    .catch(rethrowQueryFailure);
  return result.rows[0];
}
function resumeQuery(client: PoolClient, workspaceId: string) {
  const db = drizzle(client),
    task = pendingRunTasks,
    node = nodeRuns,
    call = workflowCalls;
  const tasks = db
    .select({ id: sql<string>`${task.runId}`.as('resume_id') })
    .from(task)
    .innerJoin(sql`descendants`, sql`descendants.id=${task.runId}`)
    .where(
      and(
        eq(task.workspaceId, workspaceId),
        sql`${task.status}<>'pending'`,
        isNotNull(task.nodeRunId),
        isNull(task.consumedAt),
      ),
    );
  const nodes = db
    .select({ id: node.workflowRunId })
    .from(node)
    .innerJoin(sql`descendants`, sql`descendants.id=${node.workflowRunId}`)
    .where(
      and(
        eq(node.workspaceId, workspaceId),
        inArray(node.status, ['ready', 'running']),
      ),
    );
  const calls = db
    .select({ id: call.parentRunId })
    .from(call)
    .innerJoin(sql`descendants`, sql`descendants.id=${call.parentRunId}`)
    .where(
      and(
        eq(call.workspaceId, workspaceId),
        notInArray(call.status, ['pending', 'accepted']),
        isNull(call.consumedAt),
      ),
    );
  return tasks.union(nodes).union(calls);
}
