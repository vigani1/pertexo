import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  parseCheckpoint,
} from '@pertexo/workflow-engine';
import { drizzle } from 'drizzle-orm/node-postgres';
import { parseWorkspaceId } from '@pertexo/database/primitives';
import { requestWorkflowRunCancellation } from '../../../../src/runs/commands/request-cancellation.js';
import { ExecutionStateConflictError } from '../../../../src/runs/state-errors.js';
import { createRunAdvanceStore } from '../../../../src/runs/advance/run-advance.store.js';
import {
  actorId,
  asAdmin,
  asOwner,
  asRuntime,
  databaseUrl,
  insertRun,
  ownedDeliveryStore,
  parseDatabaseConfig,
  testDelivery,
  waitForApplicationLocks,
  workerBaseUrl,
  workspaceA,
  workflowA,
} from '../run-store.fixture.js';

const applicationName = `queued-standing-${randomUUID()}`;
const url = new URL(databaseUrl(workerBaseUrl));
url.searchParams.set('application_name', applicationName);
const store = createRunAdvanceStore(
  parseDatabaseConfig({ connectionString: url.toString(), max: 2 }),
);
afterAll(() => store.close());
const signal = new AbortController().signal;
async function queuedPlan() {
  const versionId = randomUUID();
  const compiled = buildWorkflowExecutable({
    catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
    graph: {
      settings: {},
      edges: [],
      nodes: [
        {
          id: 'start',
          definition: { key: 'core.manual', version: 1 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
          position: { x: 0, y: 0 },
        },
      ],
    },
  });
  await asOwner(workspaceA, (client) =>
    client.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
    values($1,$2,$3,(select max(version_number)+1 from app.workflow_versions where workflow_id=$3),'{}',$4,$5,$6)`,
      [
        versionId,
        workspaceA,
        workflowA,
        compiled.checksum,
        compiled.envelope,
        actorId,
      ],
    ),
  );
  const checkpoint = createCheckpoint({
    workflowVersionId: versionId,
    iterationBudget: 200,
    nextEventSequence: 2,
  });
  const runId = await insertRun({
    workflowVersionId: versionId,
    schedulerState: checkpoint,
  });
  const loaded = await ownedDeliveryStore.loadAdvanceState({
    workspaceId: workspaceA,
    runId,
  });
  if (loaded.kind !== 'ready') throw new Error('Run snapshot missing');
  const state = loaded.state;
  const plan = await advanceWorkflow({
    runId,
    workflowVersionId: versionId,
    executable: compiled,
    checkpoint: state.checkpoint,
    observations: state.observations,
    completedOutputs: state.completedOutputs,
    callOutcomes: state.callOutcomes,
    taskOutcomes: state.taskOutcomes,
    hasExecutionSlot: state.hasExecutionSlot,
    occurredAt: state.occurredAt,
    maximumAdmissions: 10,
    signal,
  });
  expect(plan.checkpoint.runStatus).toBe('running');
  expect(plan.attempts).not.toHaveLength(0);
  const delivery = await testDelivery(workspaceA, runId, 0);
  return {
    runId,
    delivery,
    plan,
    compiled,
    previous: parseCheckpoint(checkpoint),
  };
}
async function commit(prepared: Awaited<ReturnType<typeof queuedPlan>>) {
  return store.advance(
    {
      workspaceId: workspaceA,
      runId: prepared.runId,
      delivery: prepared.delivery,
      signal,
    },
    () =>
      Promise.resolve({
        kind: 'transition',
        previous: prepared.previous,
        plan: prepared.plan,
      }),
  );
}
async function assertRetryableControl(
  prepared: Awaited<ReturnType<typeof queuedPlan>>,
  terminal: 'canceled' | 'timed_out',
) {
  await asAdmin(async (client) => {
    expect(
      (
        await client.query(
          `select status,(select revision from app.run_checkpoints where workflow_run_id=run.id) revision,
      (select count(*)::int from app.node_runs where workflow_run_id=run.id) nodes,
      (select completed_at is not null from app.inbox_receipts where message_id=$2) receipt_completed
      from app.workflow_runs run where id=$1`,
          [prepared.runId, prepared.delivery.outboxEventId],
        )
      ).rows,
    ).toEqual([
      { status: 'queued', revision: 0, nodes: 0, receipt_completed: null },
    ]);
  });
  const result = await store.advance(
    {
      workspaceId: workspaceA,
      runId: prepared.runId,
      delivery: prepared.delivery,
      signal,
    },
    async (state) => ({
      kind: 'transition',
      previous: parseCheckpoint(state.checkpoint),
      plan: await advanceWorkflow({
        runId: state.runId,
        workflowVersionId: state.workflowVersionId,
        executable: prepared.compiled,
        checkpoint: state.checkpoint,
        observations: state.observations,
        completedOutputs: state.completedOutputs,
        callOutcomes: state.callOutcomes,
        taskOutcomes: state.taskOutcomes,
        hasExecutionSlot: state.hasExecutionSlot,
        occurredAt: state.occurredAt,
        maximumAdmissions: 10,
        signal,
      }),
    }),
  );
  expect(result).toMatchObject({
    kind: 'committed',
    revision: 1,
    admittedAttempts: [],
  });
  await asAdmin(async (client) => {
    expect(
      (
        await client.query(
          `select status,(select count(*)::int from app.node_runs where workflow_run_id=run.id) nodes,
      (select count(*)::int from app.workflow_run_active_admissions where workflow_run_id=run.id) reserved,
      (select completed_at is not null from app.inbox_receipts where message_id=$2) receipt_completed
      from app.workflow_runs run where id=$1`,
          [prepared.runId, prepared.delivery.outboxEventId],
        )
      ).rows,
    ).toEqual([
      { status: terminal, nodes: 0, reserved: 0, receipt_completed: true },
    ]);
  });
  expect(await commit(prepared)).toEqual({
    kind: 'already_committed',
    revision: 1,
  });
}

it('does not persist a stale start plan after durable cancellation', async () => {
  const prepared = await queuedPlan();
  await asRuntime(workerBaseUrl, workspaceA, (client) =>
    requestWorkflowRunCancellation(
      { db: drizzle(client), workspaceId: parseWorkspaceId(workspaceA) },
      { runId: prepared.runId, actor: actorId },
    ),
  );
  await expect(commit(prepared)).rejects.toBeInstanceOf(
    ExecutionStateConflictError,
  );
  await assertRetryableControl(prepared, 'canceled');
});
it('refreshes the deadline after a capacity wait before persisting any executable work', async () => {
  const prepared = await queuedPlan();
  await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query(
      "update app.workflow_runs set deadline_at=clock_timestamp()+interval '1 second' where id=$1",
      [prepared.runId],
    ),
  );
  await asAdmin(async (pool) => {
    const holder = await pool.connect();
    let pending: ReturnType<typeof commit> | undefined;
    try {
      await holder.query('begin');
      await holder.query(
        'select workspace_id from app.workspace_execution_admission_counters where workspace_id=$1 for update',
        [workspaceA],
      );
      pending = commit(prepared);
      const observed = pending.then(
        (value) => value,
        (error: unknown) => error,
      );
      await waitForApplicationLocks(applicationName, 1);
      await holder.query(
        'select pg_sleep(greatest(0,extract(epoch from(deadline_at-clock_timestamp()))+0.01)) from app.workflow_runs where id=$1',
        [prepared.runId],
      );
      await holder.query('commit');
      const outcome = await observed;
      expect(
        (
          await holder.query(
            `select status,(select count(*)::int from app.node_runs where workflow_run_id=run.id) nodes
        from app.workflow_runs run where id=$1`,
            [prepared.runId],
          )
        ).rows,
      ).toEqual([{ status: 'queued', nodes: 0 }]);
      expect(outcome).toBeInstanceOf(ExecutionStateConflictError);
    } finally {
      await holder.query('rollback');
      if (pending !== undefined) await Promise.allSettled([pending]);
      holder.release();
    }
  });
  await assertRetryableControl(prepared, 'timed_out');
});
