import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { initialCheckpointFactory } from '@pertexo/core/runs';
import { createWorkflowRunDatabase } from '@pertexo/core/runs';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue/server';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';
import {
  CORE_INLINE_DEFINITION_VERSION,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';
import { createCoordinatorRuntime } from '../../../dist/runs/coordinator.runtime.js';
import { WorkerDrainState } from '../../../dist/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../dist/transport/outbox/dispatch/outbox-dispatcher.runtime.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';
import { readJ7Counters, counterRates, measureBurst } from './j7/counters.js';

const enabled = fixture.enabled && process.env.J7_MEASURE === 'true';
const describeMeasurement = enabled ? describe : describe.skip;
const REPORT = process.env.J7_REPORT;
const BURST_RUNS = 200;
const ACTIVE_LIMIT = 200;
const START_CONCURRENCY = 8;
const REPETITIONS = 3;

function node(
  id: string,
  key: string,
  config: WorkflowNode['config'] = {},
  inputMappings: WorkflowNode['inputMappings'] = {},
): WorkflowNode {
  return {
    id,
    definition: {
      key,
      version:
        key === 'core.manual' || key === 'core.terminate'
          ? 1
          : CORE_INLINE_DEFINITION_VERSION,
    },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config,
    inputMappings,
    connectionRefs: {},
  };
}

/** Manual, then `count` pure steps cycling Set, Condition, Text, then Terminate. */
function pureGraph(count: number): WorkflowGraph {
  const body: WorkflowNode[] = Array.from({ length: count }, (_, i) => {
    const id = `step-${String(i)}`;
    switch (i % 3) {
      case 0:
        return node(
          id,
          'core.set',
          {},
          {
            value: { kind: 'literal', value: i },
          },
        );
      case 1:
        return node(
          id,
          'core.condition',
          {},
          {
            condition: { kind: 'literal', value: true },
          },
        );
      default:
        return node(
          id,
          'core.text',
          { operation: 'uppercase' },
          {
            value: { kind: 'literal', value: 'pertexo' },
          },
        );
    }
  });
  const nodes = [
    node('manual', 'core.manual'),
    ...body,
    node('stop', 'core.terminate'),
  ];
  return {
    settings: { maxRunDurationMs: 3_600_000 },
    nodes,
    edges: nodes.slice(1).map((target, index) => {
      const source = nodes[index];
      if (source === undefined) throw new Error('J7 workflow is not linear');
      return {
        id: `link-${String(index)}`,
        source: {
          nodeId: source.id,
          port: source.definition.key === 'core.condition' ? 'true' : 'out',
        },
        target: { nodeId: target.id, port: 'in' },
      };
    }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts `count` runs with at most `width` in flight, like an API with a small pool. */
async function startMany(
  count: number,
  width: number,
  start: () => Promise<string>,
) {
  const ids: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < count) {
        next += 1;
        ids.push(await start());
      }
    }),
  );
  return ids;
}

describeMeasurement('Batch J7 measurements (opt-in)', () => {
  beforeAll(fixture.setup, 120_000);
  afterAll(fixture.restoreServicesAndClose);

  let admin: Pool;
  let observerQueries = 0;
  const observe = async <T extends Record<string, unknown>>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<T[]> => {
    observerQueries += 1;
    const result = await admin.query<T>(statement, [...parameters]);
    return result.rows;
  };

  async function startHarness(inlineSteps: boolean) {
    const config = (url: string, max: number) =>
      parseDatabaseConfig({ connectionString: fixture.databaseUrl(url), max });
    const owners: (() => Promise<void>)[] = [];
    const runs = createWorkflowRunDatabase(config(fixture.apiUrl, 8));
    owners.push(() => runs.close());
    const coordinator = await createCoordinatorRuntime({
      maintenanceDatabase: config(fixture.dispatcherUrl, 2),
      database: config(fixture.workerUrl, 10),
      maximumAdmissions: 32,
      inlineSteps,
      redisUrl: fixture.redisUrl,
    });
    owners.push(() => coordinator.close());
    const attempts = await testNodeAttemptRuntime(
      {
        database: config(fixture.workerUrl, 10),
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        redisUrl: fixture.redisUrl,
        workerId: `j7-${randomUUID()}`,
      },
      { registry: createPlatformNodeRegistry() },
    );
    owners.push(() => attempts.close());
    const database = createOutboxDispatcherDatabase(
      config(fixture.dispatcherUrl, 2),
    );
    const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
    const dispatcher = new OutboxDispatcher(database, producer, {
      drainState: new WorkerDrainState(),
      options: {
        // Production defaults (worker-environment.schemas.ts).
        batchSize: 25,
        jobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.executeNodeAttempt],
        leaseDurationMillis: 30_000,
        retryDelayMillis: 1_000,
        leaseOwner: `j7-${randomUUID()}`,
        pollIntervalMillis: 1_000,
      },
    });
    owners.push(async () => {
      await dispatcher.close();
      await database.close();
    });
    await Promise.all([
      coordinator.consumer.waitUntilReady(5_000),
      attempts.consumer.waitUntilReady(5_000),
      producer.waitUntilReady(5_000),
    ]);
    dispatcher.start();
    const checkpointFactory = initialCheckpointFactory({
      catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
    });
    return {
      start: async (workspaceId: string, workflowId: string) => {
        const key = createHash('sha256').update(randomUUID()).digest('hex');
        const { run } = await runs.start({
          actorId: fixture.actorId,
          workspaceId,
          workflowId,
          idempotencyKeyHash: key,
          requestHash: key,
          scope: `workflow:${workflowId}:manual`,
          input: {},
          checkpointFactory,
        });
        return run.id;
      },
      close: async () => {
        for (const close of owners.reverse()) await close();
      },
    };
  }

  async function publishWorkflow(
    workspaceId: string,
    graph: WorkflowGraph,
    name: string,
  ) {
    const workflowId = randomUUID();
    const workflowVersionId = randomUUID();
    await insertCompiledWorkflow(fixture.ownerQuery, {
      actorId: fixture.actorId,
      workspaceId,
      identity: { workflowId, workflowVersionId },
      graph,
      name,
      catalog: PLATFORM_NODE_CATALOG,
    });
    await fixture.ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, workflowVersionId],
    );
    return workflowId;
  }

  async function setWorkspaceLimit(workspaceId: string, active: number) {
    await observe(
      `with v as (insert into app.workspace_execution_entitlement_versions(workspace_id,version,active_run_limit,queued_run_limit)
         select $1,coalesce(max(version),0)+1,$2,10000 from app.workspace_execution_entitlement_versions where workspace_id=$1 returning version)
       insert into app.workspace_execution_entitlements(workspace_id,current_version) select $1,version from v
       on conflict(workspace_id) do update set current_version=excluded.current_version`,
      [workspaceId, active],
    );
  }

  async function waitAllTerminal(runIds: readonly string[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await observe<{ open: number; failed: number }>(
        `select count(*) filter (where status not in ('succeeded','failed','canceled','timed_out','outcome_unknown'))::int open,
                count(*) filter (where status in ('failed','canceled','timed_out','outcome_unknown'))::int failed
           from app.workflow_runs where id = any($1::uuid[])`,
        [runIds],
      );
      if (row === undefined) throw new Error('J7 run counters missing');
      if (row.open === 0) return row.failed;
      if (Date.now() > deadline)
        throw new Error(`Timed out with ${String(row.open)} open runs`);
      await sleep(250);
    }
  }

  const counters = async () => {
    // PostgreSQL backends flush local counters at most once per second.
    await sleep(1_200);
    return readJ7Counters(observe, observerQueries);
  };

  beforeAll(async () => {
    admin = new Pool({
      connectionString: fixture.databaseUrl(fixture.adminUrl),
      max: 2,
    });
    await admin.query('create extension if not exists pg_stat_statements');
  }, 60_000);
  afterAll(async () => admin?.end());

  it('measures paired bursts over the same 1-step and 10-step pins', async () => {
    if (REPORT === undefined) throw new Error('J7_REPORT is required');
    const workflows = [
      [1, await publishWorkflow(fixture.workspaceId, pureGraph(1), 'Pure 1')],
      [
        10,
        await publishWorkflow(fixture.workspaceId, pureGraph(10), 'Pure 10'),
      ],
    ] as const;
    await setWorkspaceLimit(fixture.workspaceId, ACTIVE_LIMIT);

    const samples = [];
    for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
      for (const inlineSteps of repetition % 2 === 1
        ? [false, true]
        : [true, false]) {
        const harness = await startHarness(inlineSteps);
        try {
          const warm = await harness.start(
            fixture.workspaceId,
            workflows[1][1],
          );
          expect(await waitAllTerminal([warm], 60_000)).toBe(0);
          const idleBefore = await counters();
          await sleep(20_000);
          const idle = counterRates(idleBefore, await counters());
          for (const [steps, workflow] of workflows) {
            const before = await counters();
            const started = performance.now();
            const ids = await startMany(BURST_RUNS, START_CONCURRENCY, () =>
              harness.start(fixture.workspaceId, workflow),
            );
            const failed = await waitAllTerminal(ids, 300_000);
            const wallMs = Math.round(performance.now() - started);
            const after = await counters();
            const [delivery] = await observe<{
              hops: number;
              attempts: number;
            }>(
              `select count(*)::int as hops,
                      count(*) filter (where job_name='execute-node-attempt')::int as attempts
                   from app.outbox_events
                  where job_name in ('advance-workflow-run','execute-node-attempt')
                    and payload->>'runId' = any($1::text[])`,
              [ids],
            );
            const sample = {
              repetition,
              inlineSteps,
              steps,
              wallMs,
              failed,
              ...measureBurst(before, after, idle, BURST_RUNS),
              deliveries: delivery,
            };
            samples.push(sample);
            await writeFile(
              REPORT,
              JSON.stringify(
                { activeLimit: ACTIVE_LIMIT, burstRuns: BURST_RUNS, samples },
                null,
                2,
              ),
            );
            expect(failed).toBe(0);
            expect(delivery?.hops).toBeGreaterThan(0);
            if (inlineSteps)
              expect(delivery?.attempts).toBeLessThan(BURST_RUNS * (steps + 2));
          }
        } finally {
          await harness.close();
        }
      }
    }
  }, 1_500_000);
});
