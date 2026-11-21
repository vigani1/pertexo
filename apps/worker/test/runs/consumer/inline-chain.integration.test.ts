import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createNodeAttemptExecutionEngine } from '../../../src/attempts/execution/engine.js';
import { advanceRun } from '@pertexo/core/runs';
import { canonicalOutboxPayloadChecksum } from '@pertexo/core/outbox';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';
import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { createCoordinatorRecoveryHarness } from '../../support/coordinator/recovery-harness.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import {
  acceptFixtureRun,
  acceptRun,
} from '../../support/coordinator/runs/accept.js';
import { forEachGraph } from '../../support/coordinator/workflows/graphs/loops.js';
import { linearGraph } from '../../support/coordinator/workflows/graphs/basic.js';
import { ServiceProcess } from '../../support/recovery/processes.js';
import {
  inlineDefinition,
  inlineFixtureCatalog,
} from './inline-chain/registration.fixture.mjs';

const describeIntegration = fixture.enabled ? describe : describe.skip;
const { actorId, workspaceId, workerQuery } = fixture;
const childPath = fileURLToPath(
  new URL('./inline-chain/coordinator.fixture.mjs', import.meta.url),
);
const markerTimeout = 10_000;

type Stage =
  | 'after-second-kernel'
  | 'before-commit'
  | 'after-commit'
  | 'stale-cas'
  | 'finish';

function graphWithInlineSteps(fail: boolean) {
  const base = linearGraph();
  const manual = base.nodes.find(({ id }) => id === 'manual');
  const set = base.nodes.find(({ id }) => id === 'set');
  if (manual === undefined || set === undefined)
    throw new Error('Inline fixture nodes are missing');
  const steps = [1, 2, 3].map((ordinal) => ({
    ...set,
    id: `step-${String(ordinal)}`,
    definition: inlineDefinition,
    inputMappings: {
      prior:
        ordinal === 1
          ? { kind: 'literal', value: 10 }
          : {
              kind: 'node_output',
              nodeId: `step-${String(ordinal - 1)}`,
              path: '$.value',
            },
      fail: { kind: 'literal', value: fail && ordinal === 2 },
    },
  }));
  const handler = {
    ...set,
    id: 'handler',
    definition: inlineDefinition,
    inputMappings: { prior: { kind: 'literal', value: 20 } },
  };
  const nodes = [manual, ...steps];
  const edges = nodes.slice(1).map(({ id }, index) => ({
    id: `inline-edge-${String(index)}`,
    source: { nodeId: nodes[index]?.id, port: 'out' },
    target: { nodeId: id, port: 'in' },
  }));
  return {
    ...base,
    nodes: fail ? [...nodes, handler] : nodes,
    edges: fail
      ? [
          ...edges,
          {
            id: 'inline-failure-edge',
            source: { nodeId: 'step-2', port: WORKFLOW_FAILURE_PORT },
            target: { nodeId: handler.id, port: 'in' },
          },
        ]
      : edges,
  };
}

function graphWithInlineLoopBody() {
  const graph = forEachGraph(1);
  const loop = graph.nodes.find(({ id }) => id === 'for-each');
  const outer = graph.nodes.find(({ id }) => id === 'outer-successor');
  if (loop === undefined || !('structured' in loop) || outer === undefined)
    throw new Error('Inline loop fixture is incomplete');
  for (const node of loop.structured.body.nodes) {
    Object.assign(node, {
      definition: inlineDefinition,
      inputMappings: {
        prior:
          node.id === 'body-map'
            ? { kind: 'structured_input', port: 'ordinal', path: '$' }
            : { kind: 'node_output', nodeId: 'body-map', path: '$.value' },
      },
    });
  }
  Object.assign(outer, {
    definition: inlineDefinition,
    inputMappings: {
      prior: {
        kind: 'node_output',
        nodeId: 'for-each',
        path: '$.results[2].value',
      },
    },
  });
  return graph;
}

async function prepareInlineDelivery(
  scenario: 'linear' | 'failure' | 'loop' = 'linear',
) {
  const identity = {
    workflowId: randomUUID(),
    workflowVersionId: randomUUID(),
  };
  await insertCompiledWorkflow(fixture.ownerQuery, {
    actorId,
    workspaceId,
    identity,
    graph:
      scenario === 'loop'
        ? graphWithInlineLoopBody()
        : graphWithInlineSteps(scenario === 'failure'),
    name: 'Inline coordinator proof',
    catalog: inlineFixtureCatalog,
  });
  const accepted = await acceptFixtureRun({
    ...identity,
    iterationBudget: scenario === 'loop' ? 3 : 0,
  });
  const databaseUrl = fixture.databaseUrl(fixture.workerUrl);
  const harness = await createCoordinatorRecoveryHarness({
    accepted,
    database: parseDatabaseConfig({ connectionString: databaseUrl, max: 4 }),
    runtimeCapabilities: {},
    workerIdPrefix: 'inline-coordinator',
    attemptEngine: createNodeAttemptExecutionEngine({
      catalog: composeExecutableCatalog(inlineFixtureCatalog),
    }),
    coordinatorFactories: {
      advance: (dependencies) => (input) =>
        advanceRun(
          {
            ...dependencies,
            verification: {
              catalog: composeExecutableCatalog(inlineFixtureCatalog),
            },
          },
          input,
        ),
    },
  });
  let outboxEventId: string;
  try {
    await harness.publishCoordinator(accepted.outboxEventId, 1);
    await harness.executeNext('manual');
    if (scenario === 'loop') {
      await harness.continueAfter(2);
      await harness.executeNext('for-each');
    }
    outboxEventId = await harness.nextCoordinatorOutbox();
  } finally {
    await harness.close();
  }
  return inlineDelivery(databaseUrl, accepted.runId, outboxEventId);
}

interface InlineDelivery {
  workspaceId: string;
  runId: string;
  delivery: { outboxEventId: string; payloadChecksum: string };
  applicationName: string;
  child(stage: Stage): ServiceProcess;
  continuation(): Promise<InlineDelivery>;
}

async function inlineDelivery(
  databaseUrl: string,
  runId: string,
  outboxEventId: string,
): Promise<InlineDelivery> {
  const [row] = await workerQuery<{ payload: unknown }>(
    'select payload from app.outbox_events where workspace_id=$1 and id=$2',
    [workspaceId, outboxEventId],
  );
  if (row === undefined) throw new Error('Inline delivery was not persisted');
  const input = {
    workspaceId,
    runId,
    delivery: {
      outboxEventId,
      payloadChecksum: canonicalOutboxPayloadChecksum(row.payload),
    },
  };
  const childDatabase = new URL(databaseUrl);
  const applicationName = `inline-fixture-${runId}`;
  childDatabase.searchParams.set('application_name', applicationName);
  return {
    ...input,
    async continuation(): Promise<InlineDelivery> {
      const [next] = await workerQuery<{ id: string }>(
        `select o.id from app.outbox_events o
         where o.workspace_id=$1 and o.aggregate_id=$2 and o.job_name='advance-workflow-run'
           and not exists (select 1 from app.inbox_receipts r
             where r.workspace_id=$1 and r.message_id=o.id)`,
        [workspaceId, input.runId],
      );
      if (next === undefined)
        throw new Error('Missing next coordinator continuation');
      return inlineDelivery(databaseUrl, runId, next.id);
    },
    applicationName,
    child(stage: Stage) {
      return new ServiceProcess(childPath, {
        INLINE_COORDINATOR_FIXTURE: JSON.stringify({
          stage,
          input,
          databaseUrl: childDatabase.href,
          maintenanceDatabaseUrl: fixture.databaseUrl(fixture.dispatcherUrl),
        }),
      });
    },
  };
}

async function readCommit(
  delivery: Awaited<ReturnType<typeof prepareInlineDelivery>>,
) {
  const keys = [workspaceId, delivery.runId, delivery.delivery.outboxEventId];
  const [checkpoint] = await workerQuery<Record<string, unknown>>(
    `select checkpoint.revision, run.status,
      (checkpoint.scheduler_state->>'nextEventSequence')::int next_sequence,
      (select count(*)::int from app.inbox_receipts where workspace_id=$1 and message_id=$3) receipt_count,
      (select count(*)::int from app.outbox_events
        where workspace_id=$1 and payload->>'runId'=$2::uuid::text) outbox_count
      from app.run_checkpoints checkpoint
      join app.workflow_runs run on run.id=checkpoint.workflow_run_id
      where checkpoint.workspace_id=$1 and checkpoint.workflow_run_id=$2`,
    keys,
  );
  const events = await workerQuery<{ sequence: number; type: string }>(
    `select sequence,type from app.run_events
      where workspace_id=$1 and workflow_run_id=$2 order by sequence`,
    keys.slice(0, 2),
  );
  const attempts = await workerQuery<{
    node_id: string;
    attempt_number: number;
    status: string;
    output_ref: unknown;
    input_ref: unknown;
    safe_error_code: string | null;
    lease_owner: string | null;
    dispatch_marked_at: string | null;
    deliveries: number;
  }>(
    `select n.node_id,a.attempt_number,n.status,a.output_ref,n.input_ref,
        a.safe_error_code,a.lease_owner,a.dispatch_marked_at,
        (select count(*)::int from app.outbox_events o
         where o.workspace_id=$1 and o.aggregate_id=a.id
           and o.job_name='execute-node-attempt') deliveries
      from app.node_runs n left join app.node_attempts a on a.node_run_id=n.id
      where n.workspace_id=$1 and n.workflow_run_id=$2 and n.node_id<>'manual'
      order by n.node_id,a.attempt_number`,
    keys.slice(0, 2),
  );
  return { checkpoint, events, attempts };
}

async function finish(
  delivery: Awaited<ReturnType<typeof prepareInlineDelivery>>,
  kind: 'committed' | 'already_committed',
) {
  const child = delivery.child('finish');
  const reached = child.waitForLog(
    /inline coordinator result:/u,
    markerTimeout,
  );
  child.startOnce();
  try {
    await reached;
    expect(
      child.linesMentioning(
        ['inline coordinator result:', `"kind":"${kind}"`],
        'info',
      ),
    ).toHaveLength(1);
  } finally {
    await child.stop('SIGTERM');
  }
}

describeIntegration('Inline coordinator transaction recovery', () => {
  beforeAll(fixture.setup);
  afterAll(fixture.restoreServicesAndClose);

  it.each(['after-second-kernel', 'before-commit', 'after-commit'] as const)(
    'redelivers exactly once when a child is killed %s',
    async (stage) => {
      const delivery = await prepareInlineDelivery();
      const before = await readCommit(delivery);
      const child = delivery.child(stage);
      const reached = child.waitForLog(
        new RegExp(`inline coordinator paused: ${stage}`, 'u'),
        markerTimeout,
      );
      child.startOnce();
      try {
        await reached;
        const paused = await readCommit(delivery);
        if (stage === 'after-commit')
          expect(paused.checkpoint).toMatchObject({
            revision: 2,
            receipt_count: 1,
          });
        else expect(paused).toEqual(before);
        if (stage === 'after-second-kernel') {
          const accepted = await acceptRun();
          expect(accepted.runId).not.toBe(delivery.runId);
        }
      } finally {
        await child.stop('SIGKILL');
      }
      await finish(
        delivery,
        stage === 'after-commit' ? 'already_committed' : 'committed',
      );
      const committed = await readCommit(delivery);
      expect(committed.checkpoint).toMatchObject({
        revision: 2,
        receipt_count: 1,
        status: 'succeeded',
        next_sequence: committed.events.length + 1,
        outbox_count: before.checkpoint?.outbox_count,
      });
      expect(committed.events.map(({ sequence }) => sequence)).toEqual(
        committed.events.map((_, index) => index + 1),
      );
      expect(committed.attempts).toEqual(
        [11, 12, 13].map((value, index) => ({
          node_id: `step-${String(index + 1)}`,
          status: 'succeeded',
          attempt_number: 1,
          output_ref: { kind: 'inline', value: { value } },
          input_ref: {
            kind: 'inline',
            value: { prior: value - 1, fail: false },
          },
          safe_error_code: null,
          lease_owner: null,
          dispatch_marked_at: null,
          deliveries: 0,
        })),
      );
      await finish(delivery, 'already_committed');
      expect(await readCommit(delivery)).toEqual(committed);
    },
  );

  it('rolls back inline attempts when the checkpoint CAS is refused', async () => {
    const delivery = await prepareInlineDelivery();
    const before = await readCommit(delivery);
    const child = delivery.child('stale-cas');
    const rejected = child.waitForLog(
      /CoordinatorRunStateCorruptError/u,
      markerTimeout,
    );
    child.startOnce();
    try {
      await rejected;
      expect(await readCommit(delivery)).toEqual(before);
    } finally {
      await child.stop('SIGTERM');
    }
    await finish(delivery, 'committed');
    expect((await readCommit(delivery)).attempts).toHaveLength(3);
  });

  it('leaves the delivery intact when its coordinator dies waiting on the run lock', async () => {
    const delivery = await prepareInlineDelivery();
    const before = await readCommit(delivery);
    const lock = await fixture.workerPool.connect();
    const child = delivery.child('finish');
    try {
      await lock.query('begin');
      await lock.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await lock.query(
        'select id from app.workflow_runs where workspace_id=$1 and id=$2 for no key update',
        [workspaceId, delivery.runId],
      );
      child.startOnce();
      await fixture.waitFor(
        () =>
          workerQuery<{ waiting: boolean }>(
            "select exists(select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock') waiting",
            [delivery.applicationName],
          ),
        (rows) => rows[0]?.waiting === true,
      );
      expect(await readCommit(delivery)).toEqual(before);
    } finally {
      try {
        await child.stop('SIGKILL');
        await lock.query('rollback');
      } finally {
        lock.release();
      }
    }
    await finish(delivery, 'committed');
    expect((await readCommit(delivery)).attempts).toHaveLength(3);
  });

  it('routes a permanent middle failure and keeps the failed attempt input', async () => {
    const delivery = await prepareInlineDelivery('failure');
    await finish(delivery, 'committed');
    const result = await readCommit(delivery);
    expect(result.checkpoint).toMatchObject({
      revision: 2,
      status: 'succeeded',
      receipt_count: 1,
    });
    expect(result.attempts).toMatchObject([
      {
        node_id: 'handler',
        status: 'succeeded',
        output_ref: { kind: 'inline', value: { value: 21 } },
      },
      { node_id: 'step-1', status: 'succeeded' },
      {
        node_id: 'step-2',
        status: 'failed',
        attempt_number: 1,
        safe_error_code: 'execution.configuration',
        input_ref: { kind: 'inline', value: { prior: 11, fail: true } },
        deliveries: 0,
      },
      { node_id: 'step-3', status: 'skipped', attempt_number: null },
    ]);
    expect(result.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        'node.failure_routed',
        'node.failure_handled',
        'run.succeeded',
      ]),
    );
  });
  it('continues at each For Each batch boundary and reads completed iteration outputs in item order', async () => {
    let delivery = await prepareInlineDelivery('loop');
    for (let batch = 1; batch <= 3; batch += 1) {
      await finish(delivery, 'committed');
      const state = await readCommit(delivery);
      expect(state.checkpoint).toMatchObject({
        revision: 2 + batch,
        status: 'running',
      });
      expect(
        state.attempts.filter(
          ({ node_id, status }) =>
            node_id === 'body-sink' && status === 'succeeded',
        ),
      ).toHaveLength(batch);
      delivery = await delivery.continuation();
    }
    await finish(delivery, 'committed');
    const final = await readCommit(delivery);
    expect(final.checkpoint).toMatchObject({
      revision: 6,
      status: 'succeeded',
    });
    expect(
      final.attempts.find(({ node_id }) => node_id === 'outer-successor'),
    ).toMatchObject({
      output_ref: { kind: 'inline', value: { value: 5 } },
      attempt_number: 1,
      deliveries: 0,
    });
  });
});
