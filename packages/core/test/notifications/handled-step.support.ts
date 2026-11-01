import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  type WorkflowTransitionPlan,
} from '@pertexo/workflow-engine';
import { expect } from 'vitest';

import { PLATFORM_NODE_CATALOG } from '../../../node-catalog/dist/index.js';
import {
  actorId,
  asOwner,
  asRuntime,
  insertRun,
  notificationDestinationId,
  notificationSecretVersionId,
  randomUUID,
  rawStore,
  testDelivery,
  workerBaseUrl,
  workspaceA,
} from '../runs/run-store/fixtures.js';

export const signal = () => new AbortController().signal;
export const OCCURRED_AT = '2026-11-01T12:00:00.000Z';
export const pinnedAlert = {
  destinationId: notificationDestinationId,
  destinationConfigVersion: 1,
  sideEffectClass: 'idempotent_with_key',
  connectionSecretVersionId: notificationSecretVersionId,
} as const;

function node(id: string, key: string) {
  return {
    id,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
}

function handledStepGraph() {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node('manual', 'core.manual'),
      node('source', 'core.set'),
      node('source-stop', 'core.terminate'),
      {
        ...node('handler', 'core.set'),
        inputMappings: {
          failure: { kind: 'node_failure', nodeId: 'source', path: '$' },
        },
      },
      node('handler-stop', 'core.terminate'),
    ],
    edges: (
      [
        ['manual', 'source', 'out'],
        ['source', 'source-stop', 'out'],
        ['source', 'handler', '__failure'],
        ['handler', 'handler-stop', 'out'],
      ] as const
    ).map(([source, target, port], index) => ({
      id: `link-${String(index)}`,
      source: { nodeId: source, port },
      target: { nodeId: target, port: 'in' },
    })),
  };
}

/** A run whose every transition is the engine's decision from what's stored. */
export async function startEngineRun() {
  const graph = handledStepGraph();
  const executable = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
  });
  const workflowId = randomUUID();
  const workflowVersionId = randomUUID();
  await asOwner(workspaceA, async (client) => {
    await client.query(
      `insert into app.workflows (id,workspace_id,name,created_by)
       values ($1,$2,'Handled step proof',$3)`,
      [workflowId, workspaceA, actorId],
    );
    await client.query(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,graph_json,
         checksum,executable_json,published_by
       ) values ($1,$2,$3,1,$4::jsonb,$5,$6::jsonb,$7)`,
      [
        workflowVersionId,
        workspaceA,
        workflowId,
        JSON.stringify(graph),
        executable.checksum,
        JSON.stringify(executable.envelope),
        actorId,
      ],
    );
  });
  const runId = await insertRun({
    workflowId,
    workflowVersionId,
    status: 'queued',
    schedulerState: createCheckpoint({
      workflowVersionId,
      iterationBudget: 100,
      nextEventSequence: 2,
    }),
    failureNotificationPolicy: pinnedAlert,
  });

  const decide = async (): Promise<WorkflowTransitionPlan> => {
    const loaded = await rawStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: signal(),
    });
    if (loaded.kind !== 'ready') throw new Error('Run was not loaded');
    return advanceWorkflow({
      runId,
      workflowVersionId,
      executable,
      checkpoint: loaded.state.checkpoint,
      observations: loaded.state.observations,
      completedOutputs: loaded.state.completedOutputs,
      occurredAt: OCCURRED_AT,
      maximumAdmissions: 10,
      signal: signal(),
    });
  };
  const save = async (
    plan: WorkflowTransitionPlan,
  ): Promise<WorkflowTransitionPlan> => {
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId,
        delivery: await testDelivery(workspaceA, runId, plan.expectedRevision),
        plan,
        signal: signal(),
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    return plan;
  };

  return { runId, decide, save };
}

async function attemptOf(runId: string, nodeId: string) {
  const { rows } = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{
      node_run_id: string;
      attempt_id: string;
      invocation_key: string;
    }>(
      `select id node_run_id,current_attempt_id attempt_id,invocation_key
         from app.node_runs where workflow_run_id=$1 and node_id=$2`,
      [runId, nodeId],
    ),
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`${nodeId} has no attempt`);
  return row;
}

/** What the worker stores when a step's attempt ends in a failure a handler can take. */
export async function failStep(runId: string, nodeId: string) {
  const attempt = await attemptOf(runId, nodeId);
  await asRuntime(workerBaseUrl, workspaceA, async (client) => {
    await client.query(
      `update app.node_runs set status='running' where id=$1`,
      [attempt.node_run_id],
    );
    await client.query(
      `update app.node_attempts
          set status='failed',safe_error_code='file.create_data',
              executor_failure_kind='failed',executor_error_kind='configuration',
              executor_possibly_dispatched=false,retry_decision='pending',
              completed_at=clock_timestamp()
        where id=$1`,
      [attempt.attempt_id],
    );
  });
}

/** What the worker stores when a step's attempt succeeds. */
export async function succeedStep(
  runId: string,
  plan: WorkflowTransitionPlan,
  nodeId: string,
) {
  const attempt = await attemptOf(runId, nodeId);
  const output = JSON.stringify({ kind: 'inline', value: {} });
  await asRuntime(workerBaseUrl, workspaceA, async (client) => {
    await client.query(
      `update app.node_attempts
          set status='succeeded',output_ref=$2::jsonb,completed_at=clock_timestamp()
        where id=$1`,
      [attempt.attempt_id, output],
    );
    await client.query(
      `update app.node_runs set status='succeeded',output_ref=$2::jsonb where id=$1`,
      [attempt.node_run_id, output],
    );
    await client.query(
      `insert into app.run_events (workspace_id,workflow_run_id,sequence,type,payload)
       values ($1,$2,$3,'node.succeeded',$4::jsonb)`,
      [
        workspaceA,
        runId,
        plan.checkpoint.nextEventSequence,
        JSON.stringify({
          nodeRunId: attempt.node_run_id,
          attemptId: attempt.attempt_id,
          invocationKey: attempt.invocation_key,
          nodeId,
          attemptNumber: 1,
        }),
      ],
    );
  });
}
