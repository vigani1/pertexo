import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { arch, cpus, platform } from 'node:os';
import { performance } from 'node:perf_hooks';

import { initialCheckpointFactory } from '@pertexo/execution';
import { createWorkflowRunDatabase } from '@pertexo/database/runs';
import {
  createOutboxDispatcherDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCoordinatorRuntime } from '../../../dist/runs/runtime.js';
import { WorkerDrainState } from '../../../dist/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../dist/transport/outbox/dispatch/runtime.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

const enabled = fixture.enabled && process.env.F09_LATENCY_SAMPLE === 'true';
const describeMeasurement = enabled ? describe : describe.skip;

function node(id: string, key: string): WorkflowNode {
  return {
    id,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings:
      key === 'core.set' ? { value: { kind: 'literal', value: 1 } } : {},
    connectionRefs: {},
  };
}

function linearGraph(): WorkflowGraph {
  const nodes = [
    node('manual', 'core.manual'),
    ...Array.from({ length: 20 }, (_, i) =>
      node(`set-${String(i)}`, 'core.set'),
    ),
    node('stop', 'core.terminate'),
  ];
  return {
    settings: { maxRunDurationMs: 120_000 },
    nodes,
    edges: nodes.slice(1).map((target, index) => ({
      id: `link-${String(index)}`,
      source: { nodeId: nodes[index]?.id ?? '', port: 'out' },
      target: { nodeId: target.id, port: 'in' },
    })),
  };
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return { count: sorted.length, median: at(0.5), p95: at(0.95), max: at(1) };
}

function describeFailure(value: unknown): unknown {
  if (!(value instanceof Error)) return { type: typeof value };
  return {
    name: value.name,
    message: value.message.replace(
      /postgres(?:ql)?:\/\/[^@]+@/gu,
      'postgresql://<REDACTED>@',
    ),
    ...(value instanceof AggregateError
      ? { errors: (value.errors as unknown[]).map(describeFailure) }
      : {}),
  };
}

async function closeRuntimes(
  owners: readonly (() => Promise<void>)[],
  primary: { error: unknown } | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  for (const close of [...owners].reverse()) {
    try {
      await close();
    } catch (error: unknown) {
      errors.push(error);
      process.stderr.write(`${JSON.stringify(describeFailure(error))}\n`);
    }
  }
  if (errors.length > 0)
    throw new AggregateError(
      primary === undefined ? errors : [primary.error, ...errors],
      'Latency runtime cleanup failed',
    );
}

interface Sample {
  durationMs: number;
  gapsMs: number[];
  executionMs: number[];
  publicationMs: number[];
  checkpointBytes: number;
}

describeMeasurement('Real dispatcher step latency (opt-in measurement)', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);

  it('records warm sequential, Condition and concurrent execution without manual job publication', async () => {
    const pollIntervalMillis = Number(
      process.env.F09_LATENCY_POLL_MILLIS ?? 250,
    );
    if (
      !Number.isInteger(pollIntervalMillis) ||
      pollIntervalMillis < 10 ||
      pollIntervalMillis > 60_000
    )
      throw new Error('Invalid measurement poll interval');
    const samples = Number(process.env.F09_LATENCY_RUNS ?? 30);
    if (!Number.isInteger(samples) || samples < 1 || samples > 100)
      throw new Error('Invalid sample count');
    const workflowId = randomUUID();
    const workflowVersionId = randomUUID();
    await insertCompiledWorkflow(fixture.ownerQuery, {
      actorId: fixture.actorId,
      workspaceId: fixture.workspaceId,
      identity: { workflowId, workflowVersionId },
      graph: linearGraph(),
      name: 'Step latency measurement',
      catalog: PLATFORM_NODE_CATALOG,
    });
    await fixture.ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, workflowVersionId],
    );
    await fixture.ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [fixture.conditionWorkflowId, fixture.conditionWorkflowVersionId],
    );
    const config = (url: string, max: number) =>
      parseDatabaseConfig({ connectionString: fixture.databaseUrl(url), max });
    const started = performance.now();
    const owners: (() => Promise<void>)[] = [];
    const claimMs: number[] = [];
    const publishMs: number[] = [];
    let primary: { error: unknown } | undefined;
    try {
      const runs = createWorkflowRunDatabase(config(fixture.apiUrl, 4));
      owners.push(() => runs.close());
      const coordinator = await createCoordinatorRuntime({
        maintenanceDatabase: config(fixture.dispatcherUrl, 2),
        database: config(fixture.workerUrl, 6),
        maximumAdmissions: 10,
        redisUrl: fixture.redisUrl,
      });
      owners.push(() => coordinator.close());
      const attempts = await testNodeAttemptRuntime(
        {
          database: config(fixture.workerUrl, 6),
          heartbeatIntervalMillis: 1_000,
          leaseDurationSeconds: 10,
          redisUrl: fixture.redisUrl,
          workerId: `latency-${randomUUID()}`,
        },
        { registry: createPlatformNodeRegistry() },
      );
      owners.push(() => attempts.close());
      const database = createOutboxDispatcherDatabase(
        config(fixture.dispatcherUrl, 2),
      );
      owners.push(() => database.close());
      const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
      owners.push(() => producer.close());
      const dispatcher = new OutboxDispatcher(
        {
          ...database,
          claimBatch: async (input) => {
            const start = performance.now();
            const result = await database.claimBatch(input);
            claimMs.push(performance.now() - start);
            return result;
          },
        },
        {
          close: () => producer.close(),
          observe: () => producer.observe(),
          isReady: () => producer.isReady(),
          waitUntilReady: (timeoutMs) => producer.waitUntilReady(timeoutMs),
          publish: async (job) => {
            const start = performance.now();
            const result = await producer.publish(job);
            publishMs.push(performance.now() - start);
            return result;
          },
        },
        {
          drainState: new WorkerDrainState(),
          options: {
            batchSize: 10,
            jobNames: [
              JOB_NAME.advanceWorkflowRun,
              JOB_NAME.executeNodeAttempt,
            ],
            leaseDurationMillis: 30_000,
            leaseOwner: `latency-${randomUUID()}`,
            retryDelayMillis: 1_000,
            pollIntervalMillis,
          },
        },
      );
      owners.splice(-2, 2, () => dispatcher.close());
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const startupMs = performance.now() - started;
      dispatcher.start();
      const checkpointFactory = initialCheckpointFactory({
        catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
      });
      const sample = async (id: string = workflowId): Promise<Sample> => {
        const key = createHash('sha256').update(randomUUID()).digest('hex');
        const { run } = await runs.start({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          workflowId: id,
          idempotencyKeyHash: key,
          requestHash: key,
          scope: `workflow:${id}:manual`,
          input: {},
          checkpointFactory,
        });
        await fixture.waitFor(
          () =>
            fixture.workerQuery<{ status: string }>(
              'select status from app.workflow_runs where workspace_id=$1 and id=$2',
              [fixture.workspaceId, run.id],
            ),
          (rows) => rows[0]?.status === 'succeeded',
          120_000,
        );
        const steps = await fixture.workerQuery<{
          gap_ms: number | null;
          execution_ms: number;
        }>(
          `
          select extract(epoch from (started_at - lag(completed_at) over (order by started_at,id)))*1000::float8 gap_ms,
                 extract(epoch from (completed_at-started_at))*1000::float8 execution_ms
          from app.node_runs where workspace_id=$1 and workflow_run_id=$2
            and status='succeeded' order by started_at,id`,
          [fixture.workspaceId, run.id],
        );
        const publications = await fixture.workerQuery<{ duration_ms: number }>(
          `
          select extract(epoch from (published_at-created_at))*1000::float8 duration_ms
          from app.outbox_events where workspace_id=$1 and payload->>'runId'=$2
            and published_at is not null`,
          [fixture.workspaceId, run.id],
        );
        const summary = await fixture.workerQuery<{
          duration_ms: number;
          checkpoint_bytes: number;
        }>(
          `
          select extract(epoch from (run.completed_at-run.created_at))*1000::float8 duration_ms,
                 octet_length(checkpoint.scheduler_state::text) checkpoint_bytes
          from app.workflow_runs run join app.run_checkpoints checkpoint
            on checkpoint.workspace_id=run.workspace_id and checkpoint.workflow_run_id=run.id
          where run.workspace_id=$1 and run.id=$2`,
          [fixture.workspaceId, run.id],
        );
        const row = summary[0];
        if (row === undefined)
          throw new Error('Completed measurement disappeared');
        if (id === workflowId) expect(steps).toHaveLength(22);
        return {
          durationMs: row.duration_ms,
          checkpointBytes: row.checkpoint_bytes,
          gapsMs: steps.flatMap((step) =>
            step.gap_ms === null ? [] : [step.gap_ms],
          ),
          executionMs: steps.map((step) => step.execution_ms),
          publicationMs: publications.map(
            (publication) => publication.duration_ms,
          ),
        };
      };
      const cold = await sample();
      for (let index = 0; index < 5; index += 1) await sample();
      const cpu = process.cpuUsage();
      const memoryBefore = process.memoryUsage();
      const sequential: Sample[] = [];
      for (let index = 0; index < samples; index += 1)
        sequential.push(await sample());
      const condition: Sample[] = [];
      for (let index = 0; index < 10; index += 1)
        condition.push(await sample(fixture.conditionWorkflowId));
      const concurrent = await Promise.all(
        Array.from({ length: 5 }, () => sample()),
      );
      const summarize = (samples: readonly Sample[]) => ({
        runs: samples.length,
        runMs: distribution(samples.map((value) => value.durationMs)),
        gapMs: distribution(samples.flatMap((value) => value.gapsMs)),
        executionMs: distribution(
          samples.flatMap((value) => value.executionMs),
        ),
        outboxCreatedToPublishedMs: distribution(
          samples.flatMap((value) => value.publicationMs),
        ),
        checkpointBytes: distribution(
          samples.map((value) => value.checkpointBytes),
        ),
      });
      const report = {
        node: process.version,
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        compiledWorker: true,
        pollIntervalMillis,
        startupMs,
        cold: summarize([cold]),
        sequential: summarize(sequential),
        condition: summarize(condition),
        concurrent: summarize(concurrent),
        claimBatchMs: distribution(claimMs),
        publishMs: distribution(publishMs),
        cpuMicros: process.cpuUsage(cpu),
        memoryBefore,
        memoryAfter: process.memoryUsage(),
        samples: { sequential, condition, concurrent },
        limitations: [
          'Vitest process hosts compiled worker runtimes; database/Redis are local Docker services',
          'Completion is sampled every 25 ms; raw step timings come from PostgreSQL rows',
          'Executor span, coordinator SQL count and exact queue claim time are not separately instrumented',
        ],
      };
      if (process.env.F09_LATENCY_REPORT !== undefined)
        await writeFile(
          process.env.F09_LATENCY_REPORT,
          JSON.stringify(report, null, 2),
        );
      process.stdout.write(
        `${JSON.stringify({ ...report, samples: undefined })}\n`,
      );
    } catch (error: unknown) {
      primary = { error };
      throw error;
    } finally {
      await closeRuntimes(owners, primary);
    }
  }, 900_000);
});
