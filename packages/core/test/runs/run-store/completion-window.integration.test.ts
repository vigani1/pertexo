import { expect, it } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
  parseCheckpoint,
} from '@pertexo/workflow-engine/server';
import {
  asOwner,
  asRuntime,
  insertRun,
  ownedDeliveryStore,
  workerBaseUrl,
  workspaceA,
  versionA,
  randomUUID,
} from './run-store.fixture.js';

it('accepts large simultaneous For Each completions under the same bound as stored outputs', async () => {
  const node = (id: string, key: string) => ({
    id,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    connectionRefs: {},
    inputMappings: {},
  });
  const loops = Array.from({ length: 6 }, (_, n) => ({
    ...node(`loop-${String(n)}`, 'core.foreach'),
    inputMappings: { items: { kind: 'run_input', path: '$.items' } },
    structured: {
      kind: 'for_each',
      maxIterations: 1,
      maxConcurrency: 1,
      body: {
        settings: {},
        nodes: [node(`body-${String(n)}`, 'core.set')],
        edges: [],
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  }));
  const graph = {
    settings: {},
    nodes: [node('manual', 'core.manual'), ...loops],
    edges: loops.map((loop) => ({
      id: `edge-${loop.id}`,
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: loop.id, port: 'in' },
    })),
  };
  const executable = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
  });
  await asOwner(workspaceA, (client) =>
    client.query(
      'update app.workflow_versions set executable_json=$2::json,checksum=$3,graph_json=$4::json where id=$1',
      [
        versionA,
        JSON.stringify(executable.envelope),
        executable.checksum,
        JSON.stringify(graph),
      ],
    ),
  );
  const base = {
    runId: randomUUID(),
    workflowVersionId: versionA,
    executable,
    maximumAdmissions: 200,
    occurredAt: '2026-11-06T12:00:00.000Z',
    signal: new AbortController().signal,
  };
  const initial = await advanceWorkflow({
    ...base,
    checkpoint: createCheckpoint({
      workflowVersionId: versionA,
      iterationBudget: 6,
    }),
    observations: [],
  });
  const manual = initial.attempts[0];
  if (manual === undefined) throw new Error('Missing manual attempt');
  const attemptId = randomUUID();
  const started = await advanceWorkflow({
    ...base,
    checkpoint: initial.checkpoint,
    observations: [
      {
        kind: 'outcome',
        sequence: initial.checkpoint.nextEventSequence,
        occurredAt: base.occurredAt,
        invocationKey: manual.invocationKey,
        attemptId,
        attemptNumber: 1,
        status: 'succeeded',
        output: { kind: 'inline', attemptId },
      },
    ],
  });
  expect(started.attempts).toHaveLength(6);
  const runId = await insertRun({
    schedulerState: started.checkpoint,
    status: 'running',
  });
  await asRuntime(workerBaseUrl, workspaceA, async (client) => {
    for (const [n, loop] of loops.entries()) {
      const nodeRunId = randomUUID(),
        completedAttemptId = randomUUID();
      const key = invocationKey({
        workflowVersionId: versionA,
        nodeId: loop.id,
      });
      const output = JSON.stringify({
        kind: 'inline',
        value: { items: ['x'.repeat(200_000)], iterationCount: 1 },
      });
      await client.query(
        "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,current_attempt_id,current_attempt_number,output_ref) values($1,$2,$3,$4,$5,'{\"branchPath\":[],\"iterationPath\":[]}','succeeded','safe',$6,1,$7::json)",
        [
          nodeRunId,
          workspaceA,
          runId,
          loop.id,
          key,
          completedAttemptId,
          output,
        ],
      );
      await client.query(
        "insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref) values($1,$2,$3,1,'succeeded','safe',$4::json)",
        [completedAttemptId, workspaceA, nodeRunId, output],
      );
      await client.query(
        "insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload) values($1,$2,$3,'node.succeeded',$4::jsonb)",
        [
          workspaceA,
          runId,
          started.checkpoint.nextEventSequence + n,
          JSON.stringify({ nodeRunId, attemptId: completedAttemptId }),
        ],
      );
    }
  });
  const input = { workspaceId: workspaceA, runId, signal: base.signal };
  const first = await ownedDeliveryStore.loadAdvanceState(input);
  if (first.kind !== 'ready') throw new Error('Missing loaded state');
  expect(first.state.completedOutputs).toHaveLength(6);
  expect(
    Buffer.byteLength(JSON.stringify(first.state.completedOutputs)),
  ).toBeGreaterThan(1_048_576);
  const plan = await advanceWorkflow({
    ...base,
    runId,
    checkpoint: first.state.checkpoint,
    observations: first.state.observations,
    completedOutputs: first.state.completedOutputs,
  });
  expect(plan.checkpoint.loops).toHaveLength(6);
  const logicalResults = [];
  for (const [width, maximumAdmissions] of [
    [6, 200],
    [1, 200],
    [2, 1],
  ] as const) {
    let current = started.checkpoint;
    const bodies = [];
    for (
      let offset = 0;
      offset < first.state.observations.length;
      offset += width
    ) {
      const observations = first.state.observations
        .slice(offset, offset + width)
        .map((fact, n) => ({
          ...(fact as Record<string, unknown>),
          sequence: current.nextEventSequence + n,
        }));
      const completedOutputs = first.state.completedOutputs
        .slice(offset, offset + width)
        .map((item, n) => ({
          ...(item as Record<string, unknown>),
          sequence: current.nextEventSequence + n,
        }));
      const part = await advanceWorkflow({
        ...base,
        maximumAdmissions,
        checkpoint: parseCheckpoint(JSON.parse(JSON.stringify(current))),
        observations,
        completedOutputs,
      });
      current = part.checkpoint;
      bodies.push(...part.attempts);
    }
    for (let turn = 0; bodies.length < 6 && turn < 10; turn++) {
      const part = await advanceWorkflow({
        ...base,
        maximumAdmissions,
        checkpoint: parseCheckpoint(JSON.parse(JSON.stringify(current))),
        observations: [],
      });
      current = part.checkpoint;
      bodies.push(...part.attempts);
    }
    expect(bodies).toHaveLength(6);
    const final = await advanceWorkflow({
      ...base,
      maximumAdmissions,
      checkpoint: current,
      observations: bodies.map((body, n) => ({
        kind: 'outcome',
        sequence: current.nextEventSequence + n,
        occurredAt: base.occurredAt,
        invocationKey: body.invocationKey,
        attemptId: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
        attemptNumber: 1,
        status: 'succeeded',
        output: {
          kind: 'inline',
          attemptId: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
        },
      })),
    });
    expect(final.checkpoint.runStatus).toBe('succeeded');
    logicalResults.push(
      final.checkpoint.invocations.map(({ invocationKey: key, status }) => ({
        key,
        status,
      })),
    );
  }
  expect(logicalResults[1]).toEqual(logicalResults[0]);
  expect(logicalResults[2]).toEqual(logicalResults[0]);
  await expect(
    ownedDeliveryStore.commitAdvancePlan({ ...input, plan }),
  ).resolves.toMatchObject({ kind: 'committed' });
});
