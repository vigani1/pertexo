import type { PoolClient } from 'pg';
import { wakeWorkflowRun, deferWorkflowRun } from '../../calls/wakeup.repository.js';
import { wakeTaskAncestors } from '../responses/respond.repository.js';

export type HumanWaitState = Readonly<{
  human_wait_started_at: Date | null;
  deadline_at: Date | null;
  deadline_expired: boolean;
  human_resume_deferred: boolean;
}>;
type RunClock = Readonly<{
  status: string;
  cancel_requested_at: Date | null;
  human_wait_started_at: Date | null;
  deadline_at: Date | null;
  absolute_deadline_at: Date | null;
  deadline_expired: boolean;
  execution_entitlement_version: number;
}>;

async function wakeRelations(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<void> {
  await wakeTaskAncestors(client, workspaceId, runId);
  const children = await client.query<{ id: string }>(
    `select child_run_id id from app.workflow_calls where workspace_id=$1 and parent_run_id=$2 and status='accepted' and child_run_id is not null`,
    [workspaceId, runId],
  );
  for (const child of children.rows)
    await wakeWorkflowRun(client, workspaceId, child.id);
}
/** Only the caller's run/checkpoint are locked. Ancestor/child state is observed. */
export async function synchronizeHumanWait(
  client: PoolClient,
  workspaceId: string,
  {
    runId,
    phase,
    alreadyDeferred = false,
  }: Readonly<{
    runId: string;
    phase: 'loading' | 'committed';
    alreadyDeferred?: boolean | undefined;
  }>,
): Promise<HumanWaitState> {
  const result = await client.query<RunClock>(
    `select status,cancel_requested_at,human_wait_started_at,deadline_at,absolute_deadline_at,execution_entitlement_version,
    deadline_at is not null and deadline_at<=clock_timestamp() deadline_expired from app.workflow_runs where workspace_id=$1 and id=$2`,
    [workspaceId, runId],
  );
  const run = result.rows[0];
  if (run === undefined) throw new Error('Human wait run is unavailable');
  const unchanged = {
    human_wait_started_at: run.human_wait_started_at,
    deadline_at: run.deadline_at,
    deadline_expired: run.deadline_expired,
    human_resume_deferred: alreadyDeferred,
  };
  const runUnavailable =
    !['running', 'waiting'].includes(run.status) ||
    run.cancel_requested_at !== null ||
    run.deadline_expired;
  if (runUnavailable) return unchanged;
  const state = await client.query<{
    all_human_waiting: boolean;
    has_human_wait: boolean;
    has_running_or_timed_work: boolean;
    lent_human_wait: boolean;
    resume_work: boolean;
    child_resume_work: boolean;
    ancestor_waiting: boolean;
  }>(
    `with recursive descendants(id) as (
      select $2::uuid union select call.child_run_id from app.workflow_calls call join descendants on call.parent_run_id=descendants.id
      where call.workspace_id=$1 and call.status='accepted' and call.child_run_id is not null
    ), ancestors(id) as (
      select parent_run_id from app.workflow_calls where workspace_id=$1 and child_run_id=$2 and status='accepted'
      union select call.parent_run_id from app.workflow_calls call join ancestors on call.child_run_id=ancestors.id where call.workspace_id=$1 and call.status='accepted'
    ), resume(id) as (
      select task.run_id from app.pending_run_tasks task join descendants on descendants.id=task.run_id
      where task.workspace_id=$1 and task.status<>'pending' and task.node_run_id is not null and task.consumed_at is null
      union select node.workflow_run_id from app.node_runs node join descendants on descendants.id=node.workflow_run_id
      where node.workspace_id=$1 and node.status in ('ready','running')
      union select call.parent_run_id from app.workflow_calls call join descendants on descendants.id=call.parent_run_id
      where call.workspace_id=$1 and call.status not in ('pending','accepted') and call.consumed_at is null
    ), structural_joins as (
      select identity->>'joinInvocationKey' invocation_key from app.run_checkpoints checkpoint
      cross join lateral jsonb_array_elements(checkpoint.scheduler_state->'joins') identity
      where checkpoint.workspace_id=$1 and checkpoint.workflow_run_id=$2
    ), physical as (
      select node.status,node.control_kind,node.wait_kind,task.status task_status,child.human_wait_started_at child_wait,call.slot_lent,
        node.status='pending' and exists(select 1 from structural_joins where invocation_key=node.invocation_key) join_barrier
      from app.node_runs node left join app.pending_run_tasks task on task.workspace_id=node.workspace_id and task.node_run_id=node.id and task.run_id=node.workflow_run_id
      left join app.workflow_calls call on call.workspace_id=node.workspace_id and call.parent_run_id=node.workflow_run_id and call.invocation_key=node.invocation_key and call.status='accepted'
      left join app.workflow_runs child on child.workspace_id=call.workspace_id and child.id=call.child_run_id
      where node.workspace_id=$1 and node.workflow_run_id=$2 and node.status in ('pending','ready','running','waiting')
    ) select
      coalesce(bool_and(coalesce(join_barrier or status='waiting' and ((control_kind='human_task' and task_status='pending') or control_kind='for_each_barrier' or (control_kind='workflow_call' and child_wait is not null)),false)),false) all_human_waiting,
      coalesce(bool_or((control_kind='human_task' and task_status='pending') or child_wait is not null),false) has_human_wait,
      coalesce(bool_or(status='running' or wait_kind in ('node_wait','retry_backoff')),false) has_running_or_timed_work,
      coalesce(bool_or(slot_lent and child_wait is not null),false) lent_human_wait,
      exists(select 1 from resume) resume_work,
      exists(select 1 from resume where id<>$2) child_resume_work,
      exists(select 1 from ancestors join app.workflow_runs ancestor on ancestor.id=ancestors.id and ancestor.workspace_id=$1 where ancestor.human_wait_started_at is not null) ancestor_waiting
    from physical`,
    [workspaceId, runId],
  );
  const facts = state.rows[0];
  if (facts === undefined) throw new Error('Human wait state is unavailable');
  // Completed Calls remain runnable work until their parent consumes the result.
  // A parent cannot execute ready siblings while its slot is lent. Keep its
  // clock paused until the human-blocked child can resume, as with a lone Call.
  const quiescent =
    (facts.all_human_waiting && facts.has_human_wait && !facts.resume_work) ||
    (facts.lent_human_wait &&
      !facts.has_running_or_timed_work &&
      !facts.child_resume_work);
  if (run.human_wait_started_at === null) {
    if (!quiescent || run.status !== 'waiting') return unchanged;
    await client.query('select app.lock_workspace_execution_counter($1)', [
      workspaceId,
    ]);
    await client.query(
      `with observed as materialized (select clock_timestamp() time) update app.workflow_runs set human_wait_started_at=observed.time,
      remaining_execution_ms=case when deadline_at is null or deadline_at is not distinct from absolute_deadline_at then null else ceil(extract(epoch from (deadline_at-observed.time))*1000)::integer end,
      deadline_at=absolute_deadline_at,deadline_wakeup_at=null,updated_at=clock_timestamp()
      from observed where workspace_id=$1 and id=$2 and human_wait_started_at is null and (deadline_at is null or deadline_at>observed.time)`,
      [workspaceId, runId],
    );
    await wakeRelations(client, workspaceId, runId);
  } else if (!quiescent) {
    const available = await humanWaitCapacityAvailable(client, workspaceId, {
      runId,
      run,
      ancestorWaiting: facts.ancestor_waiting,
    });
    if (!available) {
      if (!alreadyDeferred) await deferWorkflowRun(client, workspaceId, runId);
      return { ...unchanged, human_resume_deferred: true };
    }
    // Already declared sibling Calls share this run's paused execution clock.
    // A deadline that was expired before the pause must remain expired.
    await client.query(
      `update app.workflow_calls call set deadline_at=least(
        call.deadline_at+(clock_timestamp()-run.human_wait_started_at),run.absolute_deadline_at,
        case when run.remaining_execution_ms is null then null else clock_timestamp()+run.remaining_execution_ms*interval '1 millisecond' end,
        (select min(parent.deadline_at) from app.workflow_calls incoming join app.workflow_runs parent on parent.workspace_id=incoming.workspace_id and parent.id=incoming.parent_run_id where incoming.workspace_id=$1 and incoming.child_run_id=$2 and incoming.status='accepted'))
      from app.workflow_runs run where run.workspace_id=$1 and run.id=$2 and call.workspace_id=run.workspace_id and call.parent_run_id=run.id
        and call.status='pending' and call.deadline_at>run.human_wait_started_at`,
      [workspaceId, runId],
    );
    await client.query(
      `update app.workflow_runs set human_wait_started_at=null,
      deadline_at=least(absolute_deadline_at,case when remaining_execution_ms is null then null else clock_timestamp()+remaining_execution_ms*interval '1 millisecond' end,
        (select min(parent.deadline_at) from app.workflow_calls incoming join app.workflow_runs parent on parent.workspace_id=incoming.workspace_id and parent.id=incoming.parent_run_id where incoming.workspace_id=$1 and incoming.child_run_id=$2 and incoming.status='accepted')),
      deadline_wakeup_at=null,remaining_execution_ms=null,updated_at=clock_timestamp() where workspace_id=$1 and id=$2`,
      [workspaceId, runId],
    );
    await wakeRelations(client, workspaceId, runId);
    if (phase === 'committed')
      await wakeWorkflowRun(client, workspaceId, runId);
  } else return unchanged;
  const updated = await client.query<
    Omit<HumanWaitState, 'human_resume_deferred'>
  >(
    `select human_wait_started_at,deadline_at,deadline_at is not null and deadline_at<=clock_timestamp() deadline_expired from app.workflow_runs where workspace_id=$1 and id=$2`,
    [workspaceId, runId],
  );
  const row = updated.rows[0];
  if (row === undefined) throw new Error('Human wait clock is unavailable');
  return { ...row, human_resume_deferred: alreadyDeferred };
}

async function humanWaitCapacityAvailable(
  client: PoolClient,
  workspaceId: string,
  {
    runId,
    run,
    ancestorWaiting,
  }: Readonly<{ runId: string; run: RunClock; ancestorWaiting: boolean }>,
): Promise<boolean> {
  let available = false;
  if (!ancestorWaiting) {
    const capacity = await client.query<{ available: boolean }>(
      'select app.workflow_run_active_capacity_available($1,$2,$3) available',
      [workspaceId, run.execution_entitlement_version, runId],
    );
    available = capacity.rows[0]?.available ?? false;
  }

  return available;
}
