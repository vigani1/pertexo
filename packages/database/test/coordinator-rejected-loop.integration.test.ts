import { describe, expect, it } from 'vitest';

import { PLATFORM_NODE_CATALOG } from '../../node-catalog/dist/index.js';
import { rejectedLoopGraph } from './support/coordinator-rejected-loop-graph.js';

// Test-only compiled facade: do not add the engine to the database runtime graph.
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '../../workflow-engine/dist/index.js';

// The shared fixture supports local defaults for older suites. This suite never
// imports it until every connection has been explicitly supplied by its owner.
for (const name of [
  'DATABASE_ADMIN_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_URL',
]) {
  if (!process.env[name])
    throw new Error(`${name} must be explicitly supplied`);
}
const fixture = await import('./coordinator-run-store.fixtures.js');
const signal = () => new AbortController().signal;
const items = ['one', 'two', 'three', 'four'];

const graph = () => rejectedLoopGraph(items);

async function rejectedFixture() {
  const executable = buildWorkflowExecutable({
    graph: graph(),
    catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
  });
  const versionId = fixture.randomUUID();
  const workflowId = fixture.randomUUID();
  const pinned = buildWorkflowExecutable({
    graph: graph(),
    catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
  });
  await fixture.asOwner(fixture.workspaceA, async (client) => {
    await client.query(
      `insert into app.workflows (id,workspace_id,name,created_by)
       values ($1,$2,'Bounded rejection proof',$3)`,
      [workflowId, fixture.workspaceA, fixture.actorId],
    );
    await client.query(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,schema_version,graph_json,
         checksum,executable_json,published_by
       ) values ($1,$2,$3,1,1,$4::jsonb,$5,$6::jsonb,$7)`,
      [
        versionId,
        fixture.workspaceA,
        workflowId,
        JSON.stringify(graph()),
        pinned.checksum,
        JSON.stringify(pinned.envelope),
        fixture.actorId,
      ],
    );
  });
  const key = `${versionId}|loop|b:|i:`;
  const manualKey = `${versionId}|manual|b:|i:`;
  const manualAttemptId = fixture.randomUUID();
  const manualNodeRunId = fixture.randomUUID();
  const manualOutput = { schemaVersion: 1, kind: 'inline', value: {} };
  const current = {
    ...fixture.checkpoint({
      workflowVersionId: versionId,
      runStatus: 'running',
      nextEventSequence: 3,
      invocations: [
        {
          invocationKey: key,
          nodeId: 'loop',
          status: 'running',
          attemptNumber: 1,
          branchPath: [],
          iterationPath: [],
        },
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          status: 'succeeded',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: manualAttemptId },
        },
      ],
      admittedInvocationKeys: [key, manualKey],
    }),
    schemaVersion: 2,
    branchSelections: [],
    initialIterationBudget: 20,
    remainingIterationBudget: 20,
  };
  const runId = await fixture.insertRun({
    workflowId,
    workflowVersionId: versionId,
    schedulerState: current,
    status: 'running',
  });
  const nodeRunId = fixture.randomUUID();
  const attemptId = fixture.randomUUID();
  const output = {
    schemaVersion: 1,
    kind: 'inline',
    value: { items, iterationCount: 4 },
  };
  await fixture.asRuntime(
    fixture.workerBaseUrl,
    fixture.workspaceA,
    async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
         ) values ($1,$2,$3,'manual',$4,'{}'::jsonb,'succeeded','safe',$5,1,$6::jsonb)`,
        [
          manualNodeRunId,
          fixture.workspaceA,
          runId,
          manualKey,
          manualAttemptId,
          JSON.stringify(manualOutput),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
         ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
        [
          manualAttemptId,
          fixture.workspaceA,
          manualNodeRunId,
          JSON.stringify(manualOutput),
        ],
      );
      await client.query(
        `insert into app.run_events (workspace_id,workflow_run_id,sequence,type,payload)
         values ($1,$2,2,'node.succeeded',$3::jsonb)`,
        [
          fixture.workspaceA,
          runId,
          JSON.stringify({
            schemaVersion: 1,
            nodeRunId: manualNodeRunId,
            attemptId: manualAttemptId,
            invocationKey: manualKey,
            nodeId: 'manual',
            attemptNumber: 1,
          }),
        ],
      );
      await client.query(
        `insert into app.node_runs (
         id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
         status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
       ) values ($1,$2,$3,'loop',$4,$5::jsonb,'succeeded','safe',$6,1,$7::jsonb)`,
        [
          nodeRunId,
          fixture.workspaceA,
          runId,
          key,
          JSON.stringify({ branchPath: [], iterationPath: [] }),
          attemptId,
          JSON.stringify(output),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
         id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
       ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
        [attemptId, fixture.workspaceA, nodeRunId, JSON.stringify(output)],
      );
      await client.query(
        `insert into app.run_events (workspace_id,workflow_run_id,sequence,type,payload)
       values ($1,$2,3,'node.succeeded',$3::jsonb)`,
        [
          fixture.workspaceA,
          runId,
          JSON.stringify({
            schemaVersion: 1,
            nodeRunId,
            attemptId,
            invocationKey: key,
            nodeId: 'loop',
            attemptNumber: 1,
          }),
        ],
      );
    },
  );
  const loaded = await fixture.rawStore.loadAdvanceState({
    workspaceId: fixture.workspaceA,
    runId,
    signal: signal(),
  });
  if (loaded.kind !== 'ready')
    throw new Error('real persisted success was not loaded');
  const plan = await advanceWorkflow({
    runId,
    workflowVersionId: versionId,
    executable,
    checkpoint: loaded.state.checkpoint,
    observations: loaded.state.observations,
    completedOutputs: loaded.state.completedOutputs,
    occurredAt: '2026-10-02T12:00:00.000Z',
    maximumAdmissions: 1,
    signal: signal(),
  });
  expect(plan.events).toEqual([
    expect.objectContaining({
      name: 'node.failed',
      nodeId: 'loop',
      reasonCode: 'loop_limit_exceeded',
    }),
    expect.objectContaining({ name: 'run.failed' }),
  ]);
  expect(plan.checkpoint.runStatus).toBe('failed');
  expect(plan.checkpoint.loops).toEqual([]);
  expect(plan.nodeRunAdmissions).toEqual([]);
  expect(plan.attempts).toEqual([]);
  const delivery = await fixture.testDelivery(fixture.workspaceA, runId, 0);
  const commit = (candidate: unknown = plan) =>
    fixture.rawStore.commitAdvancePlan({
      workspaceId: fixture.workspaceA,
      runId,
      workflowVersionId: versionId,
      delivery,
      plan: candidate,
      signal: signal(),
    });
  return { runId, nodeRunId, attemptId, output, manualOutput, plan, commit };
}

async function persisted(runId: string) {
  return fixture.asRuntime(
    fixture.workerBaseUrl,
    fixture.workspaceA,
    async (client) => {
      const nodes = await client.query(
        `select node.node_id,node.status,node.safe_error_code,node.output_ref,
              attempt.status as attempt_status,attempt.output_ref as attempt_output_ref
       from app.node_runs node join app.node_attempts attempt on attempt.id=node.current_attempt_id
       where node.workspace_id=$1 and node.workflow_run_id=$2 order by node.node_id`,
        [fixture.workspaceA, runId],
      );
      const events = await client.query<{ type: string; payload: unknown }>(
        `select type,payload from app.run_events where workspace_id=$1 and workflow_run_id=$2 order by sequence`,
        [fixture.workspaceA, runId],
      );
      return { nodes: nodes.rows, events: events.rows };
    },
  );
}

describe('independently derived bounded For Each rejection settlement', () => {
  it('settles the real engine plan without rewriting executor success, and reloads/replays it', async () => {
    const state = await rejectedFixture();
    await expect(state.commit()).resolves.toMatchObject({
      kind: 'committed',
      revision: 1,
    });
    const rows = await persisted(state.runId);
    expect(rows.nodes).toEqual([
      expect.objectContaining({
        node_id: 'loop',
        status: 'failed',
        safe_error_code: 'loop_limit_exceeded',
        attempt_status: 'succeeded',
        output_ref: null,
        attempt_output_ref: state.output,
      }),
      expect.objectContaining({
        node_id: 'manual',
        status: 'succeeded',
        attempt_status: 'succeeded',
        output_ref: state.manualOutput,
        attempt_output_ref: state.manualOutput,
      }),
    ]);
    expect(
      rows.events.filter((event) => event.type === 'node.failed'),
    ).toHaveLength(1);
    expect(
      rows.events.filter((event) => event.type === 'run.failed'),
    ).toHaveLength(1);
    const fresh = fixture.createTestRunStore(
      fixture.parseDatabaseConfig({
        connectionString: fixture.databaseUrl(fixture.workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
      }),
    );
    try {
      await expect(
        fresh.loadAdvanceState({
          workspaceId: fixture.workspaceA,
          runId: state.runId,
          signal: signal(),
        }),
      ).resolves.toMatchObject({
        kind: 'ready',
        state: { checkpoint: { revision: 1, runStatus: 'failed', loops: [] } },
      });
    } finally {
      await fresh.close();
    }
    await expect(state.commit()).resolves.toMatchObject({
      kind: 'already_committed',
      revision: 1,
    });
    expect(await persisted(state.runId)).toEqual(rows);
  });
});
