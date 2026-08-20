/* global AbortController, AbortSignal, process, setImmediate, setTimeout */

import { createHash } from 'node:crypto';

import {
  CheckpointRevisionConflictError,
  claimNodeAttempt,
  commitCoordinatorTransition,
  commitDueNodeAdmission,
  completeNodeAttempt,
  createWorkspaceDatabase,
  markNodeAttemptDispatched,
  parseDatabaseConfig,
  requestWorkflowRunCancellation,
  suspendNodeAttemptUntil,
} from '@pertexo/database';
import { createQueueTraceRunner } from '@pertexo/observability/queue-tracing';
import { createQueueConsumer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import {
  advanceWorkflow,
  parseCheckpoint,
} from '@pertexo/workflow-engine/testing';
import { sql } from 'drizzle-orm';

const input = JSON.parse(process.env.PHASE0E_CHILD_INPUT ?? '{}');
const action = process.argv[2];
const workerUrl = process.env.DATABASE_WORKER_URL;
const apiUrl = process.env.DATABASE_API_URL;
const redisUrl = process.env.PHASE0E_REDIS_URL;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function workspaceDatabase(connectionString) {
  if (!connectionString) throw new Error('child database URL missing');
  return createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString, max: 1 }),
  );
}

async function loadRecoveryFacts(database) {
  return database.withWorkspace(input.workspaceId, async ({ db }) => {
    const result = await db.execute(sql`
      select v.graph, c.scheduler_state, c.revision
      from app.workflow_runs r
      join app.phase0e_workflow_versions v
        on v.workspace_id = r.workspace_id
       and v.id = r.workflow_version_id
      join app.run_checkpoints c
        on c.workspace_id = r.workspace_id
       and c.workflow_run_id = r.id
      where r.workspace_id = ${input.workspaceId}
        and r.id = ${input.runId}
    `);
    const row = result.rows[0];
    if (!row) throw new Error('immutable recovery fixture missing');
    return row;
  });
}

function schedulerGraph(graph) {
  return {
    nodes: graph.nodes.map(({ id }) => ({ id })),
    edges: graph.edges.map(({ source, target }) => ({ source, target })),
  };
}

function admission(plan) {
  const planned = plan.attempts[0];
  if (!planned) throw new Error('recovery plan has no attempt');
  return {
    attemptId: input.attemptId,
    attemptNumber: planned.attemptNumber,
    branchContext: { recoveredByPid: process.pid },
    inputRef: { inline: { value: 7 } },
    invocationKey: `engine:${createHash('sha256').update(planned.invocationKey).digest('hex')}`,
    nodeId: planned.nodeId,
    nodeRunId: input.nodeRunId,
    providerIdempotencyKey: null,
    sideEffectClass: 'safe',
  };
}

async function computePlan(database) {
  const facts = await loadRecoveryFacts(database);
  const checkpoint = parseCheckpoint(facts.scheduler_state);
  const plan = advanceWorkflow({
    checkpoint,
    graph: schedulerGraph(facts.graph),
    maximumAdmissions: 1,
    occurredAt: input.occurredAt,
  });
  return { facts, plan };
}

async function coordinator(mode) {
  const database = workspaceDatabase(workerUrl);
  try {
    const computed = await computePlan(database);
    const plan = input.replayPlan ?? computed.plan;
    if (mode === 'compute_hang') {
      emit({
        injectionPoint: 'coordinator.compute_complete_before_checkpoint_cas',
        pid: process.pid,
        plan,
        workflowVersionId: plan.checkpoint.workflowVersionId,
      });
      await new Promise(() => undefined);
      return;
    }
    try {
      const result = await database.withWorkspace(
        input.workspaceId,
        (transaction) =>
          commitCoordinatorTransition(transaction, {
            admissions: [admission(plan)],
            engineVersion: input.engineVersion,
            event: { payload: {}, type: 'run.started' },
            expectedRevision: plan.expectedRevision,
            nextRunStatus: 'running',
            resumeAt: null,
            runId: input.runId,
            schedulerState: plan.checkpoint,
            traceparent: input.traceparent,
          }),
      );
      emit({
        injectionPoint: 'coordinator.checkpoint_committed_before_queue_ack',
        pid: process.pid,
        plan,
        result,
      });
      if (mode === 'commit_hang') await new Promise(() => undefined);
    } catch (error) {
      if (error instanceof CheckpointRevisionConflictError) {
        emit({ duplicateFenced: true, pid: process.pid });
        return;
      }
      throw error;
    }
  } finally {
    await database.close();
  }
}

async function claim(mode) {
  const database = workspaceDatabase(workerUrl);
  try {
    const lease = await database.withWorkspace(
      input.workspaceId,
      (transaction) =>
        claimNodeAttempt(transaction, {
          attemptId: input.attemptId,
          leaseDurationSeconds: input.leaseDurationSeconds ?? 1,
          workerId: input.workerId,
        }),
    );
    if (lease && input.markDispatched) {
      await database.withWorkspace(input.workspaceId, (transaction) =>
        markNodeAttemptDispatched(transaction, {
          attemptId: input.attemptId,
          fenceToken: lease.fenceToken,
          workerId: input.workerId,
        }),
      );
      if (input.providerEffectKey) {
        await database.withWorkspace(input.workspaceId, ({ db }) =>
          db.execute(sql`
            insert into app.phase0e_provider_effects (
              workspace_id, effect_key, invocation_count
            ) values (${input.workspaceId}, ${input.providerEffectKey}, 1)
            on conflict (workspace_id, effect_key) do nothing
          `),
        );
      }
    }
    emit({
      injectionPoint: input.markDispatched
        ? 'attempt.provider_dispatch_complete_before_attempt_commit'
        : 'attempt.claim_complete_before_provider_dispatch',
      lease,
      pid: process.pid,
    });
    if (mode === 'claim_hang') await new Promise(() => undefined);
  } finally {
    await database.close();
  }
}

async function cancel() {
  const database = workspaceDatabase(apiUrl);
  try {
    const result = await database.withWorkspace(
      input.workspaceId,
      (transaction) =>
        requestWorkflowRunCancellation(transaction, {
          actor: 'phase0e-child-api',
          reason: 'process-boundary cancellation proof',
          runId: input.runId,
        }),
    );
    emit({ canceled: result, pid: process.pid });
  } finally {
    await database.close();
  }
}

async function admitAfterCancel() {
  const database = workspaceDatabase(workerUrl);
  try {
    const facts = await loadRecoveryFacts(database);
    try {
      await database.withWorkspace(input.workspaceId, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [
            {
              attemptId: input.attemptId,
              attemptNumber: 1,
              branchContext: {},
              invocationKey: `engine:${input.attemptId}`,
              nodeId: 'canceled-admission',
              nodeRunId: input.nodeRunId,
              providerIdempotencyKey: null,
              sideEffectClass: 'safe',
            },
          ],
          engineVersion: input.engineVersion,
          event: { payload: {}, type: 'run.succeeded' },
          expectedRevision: facts.revision,
          nextRunStatus: 'succeeded',
          resumeAt: null,
          runId: input.runId,
          schedulerState: facts.scheduler_state,
          traceparent: input.traceparent,
        }),
      );
      emit({ admissionBlocked: false, pid: process.pid });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'execution.cancel_stops_admission'
      ) {
        emit({
          admissionBlocked: true,
          error: error.message,
          pid: process.pid,
        });
        return;
      }
      throw error;
    }
  } finally {
    await database.close();
  }
}

async function engineRoundtrip() {
  const database = workspaceDatabase(workerUrl);
  try {
    const facts = await loadRecoveryFacts(database);
    const checkpoint = parseCheckpoint(
      JSON.parse(JSON.stringify(facts.scheduler_state)),
    );
    const plan = advanceWorkflow({
      checkpoint,
      maximumAdmissions: input.maximumAdmissions,
      observations: input.observations,
      occurredAt: input.occurredAt,
    });
    emit({
      checkpointJson: JSON.stringify(plan.checkpoint),
      pid: process.pid,
      plan,
      persistedRevision: facts.revision,
    });
  } finally {
    await database.close();
  }
}

async function recoverEngineTransition(mode) {
  const database = workspaceDatabase(workerUrl);
  try {
    const facts = await loadRecoveryFacts(database);
    const checkpoint = parseCheckpoint(
      JSON.parse(JSON.stringify(facts.scheduler_state)),
    );
    const plan =
      input.replayPlan ??
      advanceWorkflow({
        checkpoint,
        graph: schedulerGraph(facts.graph),
        maximumAdmissions: input.maximumAdmissions,
        observations: input.observations,
        occurredAt: input.occurredAt,
      });
    const immutableGraphChecksum = createHash('sha256')
      .update(JSON.stringify(facts.graph))
      .digest('hex');
    if (mode === 'compute_hang') {
      emit({
        immutableGraphChecksum,
        injectionPoint:
          'scheduler.recovery_complete_before_recovered_checkpoint_cas',
        persistedRevision: facts.revision,
        pid: process.pid,
        plan,
        workflowVersionId: checkpoint.workflowVersionId,
      });
      await new Promise(() => undefined);
      return;
    }
    try {
      const result = await database.withWorkspace(
        input.workspaceId,
        (transaction) =>
          commitCoordinatorTransition(transaction, {
            admissions: [],
            engineVersion: input.engineVersion,
            expectedRevision: plan.expectedRevision,
            nextRunStatus: 'running',
            resumeAt: null,
            runId: input.runId,
            schedulerState: plan.checkpoint,
            traceparent: input.traceparent,
          }),
      );
      emit({
        immutableGraphChecksum,
        injectionPoint:
          'scheduler.recovered_checkpoint_committed_before_delivery_ack',
        persistedRevision: facts.revision,
        pid: process.pid,
        plan,
        result,
        workflowVersionId: checkpoint.workflowVersionId,
      });
      if (mode === 'commit_hang') await new Promise(() => undefined);
    } catch (error) {
      if (error instanceof CheckpointRevisionConflictError) {
        emit({
          duplicateFenced: true,
          immutableGraphChecksum,
          pid: process.pid,
          replayExpectedRevision: plan.expectedRevision,
        });
        return;
      }
      throw error;
    }
  } finally {
    await database.close();
  }
}

async function resumeDueNode() {
  const database = workspaceDatabase(workerUrl);
  try {
    try {
      const result = await database.withWorkspace(
        input.workspaceId,
        (transaction) =>
          commitDueNodeAdmission(transaction, {
            attemptId: input.attemptId,
            engineVersion: input.engineVersion,
            expectedAttemptNumber: input.expectedAttemptNumber,
            expectedRevision: input.expectedRevision,
            nodeRunId: input.nodeRunId,
            schedulerState: input.schedulerState,
            traceparent: input.traceparent,
          }),
      );
      emit({ duplicateFenced: false, pid: process.pid, result });
    } catch (error) {
      if (error instanceof CheckpointRevisionConflictError) {
        emit({ duplicateFenced: true, pid: process.pid });
        return;
      }
      throw error;
    }
  } finally {
    await database.close();
  }
}

async function createChildTelemetry() {
  const [{ NodeSDK }, api] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/api'),
  ]);
  const exportedSpans = [];
  const exporter = {
    export(spans, callback) {
      exportedSpans.push(...spans);
      callback({ code: 0 });
    },
    async forceFlush() {
      return undefined;
    },
    async shutdown() {
      return undefined;
    },
  };
  const sdk = new NodeSDK({ instrumentations: [], traceExporter: exporter });
  sdk.start();
  return {
    activeSpan() {
      return api.trace.getSpan(api.context.active());
    },
    async finish() {
      await sdk.shutdown();
      const span = exportedSpans.find(
        (candidate) => candidate.name === 'transport.queue.handler',
      );
      if (!span) throw new Error('queue consumer span was not exported');
      return {
        attributes: span.attributes,
        kind: span.kind,
        parentSpanId: span.parentSpanContext?.spanId,
        spanId: span.spanContext().spanId,
        traceId: span.spanContext().traceId,
      };
    },
    runner: createQueueTraceRunner(),
  };
}

async function consumeAttempt(mode) {
  if (!redisUrl) throw new Error('child Redis URL missing');
  const database = workspaceDatabase(workerUrl);
  const telemetry =
    mode === 'complete_traced' ? await createChildTelemetry() : null;
  const consumer = createQueueConsumer({
    drainTimeoutMs: 5_000,
    queueName: QUEUE_NAME.nodeAttempts,
    redisUrl,
    timeoutMs: 30_000,
    ...(telemetry === null ? {} : { traceRunner: telemetry.runner }),
    handler: async (delivery) => {
      if (delivery.name !== JOB_NAME.executeNodeAttempt) return;
      const lease = await database.withWorkspace(
        delivery.data.workspaceId,
        (transaction) =>
          claimNodeAttempt(transaction, {
            attemptId: delivery.data.attemptId,
            leaseDurationSeconds: 5,
            workerId: input.workerId,
          }),
      );
      if (!lease) return;
      const activeSpan = telemetry?.activeSpan();
      const activeSpanContext = activeSpan?.spanContext();
      if (mode === 'wait') {
        await database.withWorkspace(delivery.data.workspaceId, (transaction) =>
          suspendNodeAttemptUntil(transaction, {
            attemptId: lease.attemptId,
            dueAt: new Date(input.resumeAt),
            fenceToken: lease.fenceToken,
            safeErrorCode: null,
            workerId: input.workerId,
          }),
        );
      } else {
        await database.withWorkspace(delivery.data.workspaceId, (transaction) =>
          completeNodeAttempt(transaction, {
            attemptId: lease.attemptId,
            fenceToken: lease.fenceToken,
            outputRef: { inline: { resumedByPid: process.pid } },
            status: 'succeeded',
            traceparent: input.traceparent,
            workerId: input.workerId,
          }),
        );
      }
      setImmediate(async () => {
        await consumer.close();
        await database.close();
        const exportedSpan = await telemetry?.finish();
        emit({
          activeSpan:
            activeSpanContext === undefined
              ? null
              : {
                  spanId: activeSpanContext.spanId,
                  traceId: activeSpanContext.traceId,
                },
          deliveryTraceparent: delivery.data.traceparent,
          exportedSpan,
          injectionPoint:
            mode === 'wait'
              ? 'wait.persisted_before_worker_exit'
              : 'wait.fresh_worker_completed_resumed_attempt',
          pid: process.pid,
          status: mode === 'wait' ? 'suspended' : 'completed',
        });
        process.exit(0);
      });
    },
  });
  await consumer.waitUntilReady(5_000);
  emit({ pid: process.pid, ready: true });
}

async function consumeCooperativeCancellation() {
  if (!redisUrl) throw new Error('child Redis URL missing');
  const database = workspaceDatabase(workerUrl);
  const consumer = createQueueConsumer({
    drainTimeoutMs: 10_000,
    queueName: QUEUE_NAME.nodeAttempts,
    redisUrl,
    timeoutMs: 30_000,
    handler: async (delivery, context) => {
      if (delivery.name !== JOB_NAME.executeNodeAttempt) return;
      const lease = await database.withWorkspace(
        delivery.data.workspaceId,
        (transaction) =>
          claimNodeAttempt(transaction, {
            attemptId: delivery.data.attemptId,
            leaseDurationSeconds: 30,
            workerId: input.workerId,
          }),
      );
      if (!lease) return;

      await database.withWorkspace(delivery.data.workspaceId, ({ db }) =>
        db.execute(sql`
          insert into app.phase0e_provider_effects (
            workspace_id, effect_key, invocation_count
          ) values (${delivery.data.workspaceId}, ${input.providerEffectKey}, 1)
          on conflict (workspace_id, effect_key)
          do update set invocation_count = app.phase0e_provider_effects.invocation_count
        `),
      );

      const durableCancellation = new AbortController();
      const executorSignal = AbortSignal.any([
        context.signal,
        durableCancellation.signal,
      ]);
      let polling = true;
      const pollCancellation = async () => {
        while (polling && !durableCancellation.signal.aborted) {
          const canceled = await database.withWorkspace(
            delivery.data.workspaceId,
            ({ db }) =>
              db
                .execute(
                  sql`
                  select cancel_requested_at
                  from app.workflow_runs
                  where workspace_id = ${delivery.data.workspaceId}
                    and id = ${delivery.data.runId}
                `,
                )
                .then((result) => result.rows[0]?.cancel_requested_at != null),
          );
          if (canceled) {
            durableCancellation.abort(
              new Error('durable workflow cancellation observed'),
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      const pollingPromise = pollCancellation();

      emit({
        executorSignalAborted: executorSignal.aborted,
        injectionPoint:
          'executor.cooperative_work_active_after_completed_effect',
        pid: process.pid,
        providerEffectKey: input.providerEffectKey,
      });
      try {
        await new Promise((resolve, reject) => {
          executorSignal.addEventListener(
            'abort',
            () => reject(executorSignal.reason),
            { once: true },
          );
        });
        throw new Error('cooperative executor unexpectedly completed');
      } catch (error) {
        if (!durableCancellation.signal.aborted) throw error;
      } finally {
        polling = false;
        await pollingPromise;
      }

      await database.withWorkspace(delivery.data.workspaceId, (transaction) =>
        completeNodeAttempt(transaction, {
          attemptId: lease.attemptId,
          errorSummary: 'Canceled after durable request',
          fenceToken: lease.fenceToken,
          outputRef: {
            completedEffectKey: input.providerEffectKey,
            completedEffectTruthful: true,
          },
          safeErrorCode: 'execution.canceled',
          status: 'canceled',
          traceparent: delivery.data.traceparent,
          workerId: input.workerId,
        }),
      );

      emit({
        abortReason:
          durableCancellation.signal.reason instanceof Error
            ? durableCancellation.signal.reason.message
            : String(durableCancellation.signal.reason),
        durableSignalAborted: durableCancellation.signal.aborted,
        executorSignalAborted: executorSignal.aborted,
        injectionPoint: 'executor.cooperative_cancellation_committed',
        pid: process.pid,
        providerEffectKey: input.providerEffectKey,
        transportSignalAborted: context.signal.aborted,
      });
      setImmediate(async () => {
        await consumer.close();
        await database.close();
        process.exit(0);
      });
    },
  });
  await consumer.waitUntilReady(5_000);
  emit({ pid: process.pid, ready: true });
}

switch (action) {
  case 'compute-hang':
    await coordinator('compute_hang');
    break;
  case 'commit':
    await coordinator('commit');
    break;
  case 'commit-hang':
    await coordinator('commit_hang');
    break;
  case 'claim':
    await claim('claim');
    break;
  case 'claim-hang':
    await claim('claim_hang');
    break;
  case 'cancel':
    await cancel();
    break;
  case 'admit-after-cancel':
    await admitAfterCancel();
    break;
  case 'engine-roundtrip':
    await engineRoundtrip();
    break;
  case 'engine-recover-compute-hang':
    await recoverEngineTransition('compute_hang');
    break;
  case 'engine-recover-commit':
    await recoverEngineTransition('commit');
    break;
  case 'engine-recover-commit-hang':
    await recoverEngineTransition('commit_hang');
    break;
  case 'resume-due':
    await resumeDueNode();
    break;
  case 'consume-wait':
    await consumeAttempt('wait');
    break;
  case 'consume-complete':
    await consumeAttempt('complete');
    break;
  case 'consume-complete-traced':
    await consumeAttempt('complete_traced');
    break;
  case 'consume-cancel-cooperative':
    await consumeCooperativeCancellation();
    break;
  default:
    throw new Error(`unknown Phase 0E child action: ${String(action)}`);
}
