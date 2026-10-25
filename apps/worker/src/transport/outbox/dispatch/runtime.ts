import { EMPTY_RESULT } from '../dispatch-result.js';
import { randomUUID } from 'node:crypto';

import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
} from '@pertexo/database/outbox';
import {
  createTransportMetrics,
  type TransportJob,
  type TransportMetrics,
} from '@pertexo/observability';
import {
  JOB_NAME,
  QUEUE_FOR_JOB,
  type JobName,
  type QueueProducer,
} from '@pertexo/queue';
import type { WorkerDrainState } from '../../../runtime/shutdown/drain-state.js';
import { transportJobForName } from '../../job.js';
import { OutboxPublicationSettlements } from '../publication-settlements.js';
import {
  recordOutboxClaim,
  summarizeDispatchOutcomes,
  type OutboxPublicationOutcome,
} from '../dispatch-result.js';
import { bounded } from '../operation-deadline.js';
import { OutboxCapacitySampler } from './capacity.js';
import {
  observeDispatchMetrics,
  observeDispatchQueues,
  observeDispatchBacklog,
} from './observations.js';
import { closeDispatcherDependencies } from './lifecycle.js';
import {
  ACTIVE_POLL_INTERVAL_MILLIS,
  type DispatchPollingState,
  nextDispatchPolling,
} from './cadence.js';
import {
  transportJobName,
  transportErrorClass,
  toQueueJob,
  errorCode,
} from './delivery.js';
import { OutboxDispatcherClosedError } from './errors.js';
import type {
  OutboxDispatcherOptions,
  OutboxDispatcherRuntimeHooks,
  OutboxDispatchResult,
} from './contract.js';

export class OutboxDispatcher {
  private readonly capacitySamples: OutboxCapacitySampler;
  private readonly options: Required<OutboxDispatcherOptions>;
  private readonly enabledQueueNames: ReadonlySet<string>;

  private readonly publicationSettlements: OutboxPublicationSettlements;

  private readonly activeDispatches = new Set<Promise<void>>();
  private lifecycle: 'idle' | 'running' | 'closed' = 'idle';
  private closePromise: Promise<void> | undefined;
  private loopPromise: Promise<void> | undefined;
  private wakeLoop: (() => void) | undefined;

  private readonly drainState: WorkerDrainState;
  private readonly metrics: TransportMetrics;
  public constructor(
    private readonly database: OutboxDispatcherDatabase,
    private readonly producer: QueueProducer,
    {
      drainState,
      options,
      metrics = createTransportMetrics(),
    }: Readonly<{
      drainState: WorkerDrainState;
      options: OutboxDispatcherOptions;
      metrics?: TransportMetrics | undefined;
    }>,
  ) {
    const jobNames = [...options.jobNames];
    if (jobNames.length > 64 || new Set(jobNames).size !== jobNames.length)
      throw new TypeError(
        'Outbox job allowlist must be unique and contain at most 64 entries',
      );
    this.drainState = drainState;
    this.metrics = metrics;

    this.options = Object.freeze({
      operationTimeoutMillis: 5_000,
      pollIntervalMillis: 250,
      ...options,
      jobNames: Object.freeze(jobNames),
    });
    this.capacitySamples = new OutboxCapacitySampler(
      this.options.operationTimeoutMillis,
    );
    this.publicationSettlements = new OutboxPublicationSettlements(
      database,
      this.options.operationTimeoutMillis,
    );
    this.enabledQueueNames = new Set(
      this.options.jobNames.map((jobName: JobName) => QUEUE_FOR_JOB[jobName]),
    );
  }

  public start(): void {
    this.assertOpen();
    if (this.lifecycle === 'running') return;
    this.lifecycle = 'running';
    this.loopPromise = this.runLoop();
    void this.loopPromise.catch(() => undefined);
  }

  public configureRuntimeHooks(hooks: OutboxDispatcherRuntimeHooks): void {
    this.assertOpen();
    if (this.lifecycle !== 'idle' || this.capacitySamples.configured) {
      throw new Error('Outbox dispatcher runtime hooks are already configured');
    }
    this.capacitySamples.configure(Object.freeze(hooks));
  }

  public dispatchOnce(): Promise<OutboxDispatchResult> {
    const operation = this.runDispatchOnce();
    const ownership = operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.activeDispatches.delete(ownership);
      });
    this.activeDispatches.add(ownership);
    return operation;
  }

  private async runDispatchOnce(): Promise<OutboxDispatchResult> {
    this.assertOpen();
    if (!this.drainState.canAcceptWork()) return EMPTY_RESULT;
    if (this.options.jobNames.length === 0) return EMPTY_RESULT;

    const claim = await this.database.claimBatch({
      enabledJobNames: this.options.jobNames,
      leaseDurationMillis: this.options.leaseDurationMillis,
      leaseOwner: this.options.leaseOwner,
      leaseToken: randomUUID(),
      limit: this.options.batchSize,
      maxAttempts: this.options.maxAttempts,
    });
    const { events } = claim;
    observeDispatchMetrics(() => {
      recordOutboxClaim(this.metrics, events, claim.exhaustedCount);
    });
    const outcomes = await Promise.all(
      events.map((event) => this.publishAndSettle(event)),
    );
    await Promise.all([
      observeDispatchBacklog(this.database, this.metrics, {
        timeoutMillis: this.options.operationTimeoutMillis,
        jobNames: this.options.jobNames,
      }),
      observeDispatchQueues(this.producer, this.metrics, {
        timeoutMillis: this.options.operationTimeoutMillis,
        enabledQueueNames: this.enabledQueueNames,
      }),
    ]);
    return summarizeDispatchOutcomes(events.length, outcomes);
  }

  public async checkReadiness(): Promise<void> {
    this.assertOpen();
    if (!this.drainState.canAcceptWork()) {
      throw new Error('Outbox dispatcher is draining');
    }
    await Promise.all([
      this.database.checkReadiness(),
      this.producer.waitUntilReady(),
    ]);
    this.assertOpen();
    if (!this.drainState.canAcceptWork()) {
      throw new Error('Outbox dispatcher is draining');
    }
  }

  public close(): Promise<void> {
    this.closePromise ??= this.closeOwned();
    return this.closePromise;
  }

  private async closeOwned(): Promise<void> {
    this.lifecycle = 'closed';
    this.capacitySamples.stop();
    this.wakeLoop?.();
    const drain = this.drainOwnedWork();
    let drainFailures: readonly unknown[];
    try {
      drainFailures = await bounded(drain, this.options.operationTimeoutMillis);
    } catch (error: unknown) {
      void drain
        .then((failures) =>
          closeDispatcherDependencies(this.database, this.producer, {
            timeoutMillis: this.options.operationTimeoutMillis,
            earlierFailures: failures,
          }),
        )
        .catch(() => undefined);
      throw error;
    }
    await closeDispatcherDependencies(this.database, this.producer, {
      timeoutMillis: this.options.operationTimeoutMillis,
      earlierFailures: drainFailures,
    });
  }

  private async drainOwnedWork(): Promise<readonly unknown[]> {
    const operations = [
      ...(this.loopPromise === undefined ? [] : [this.loopPromise]),
      ...this.activeDispatches,
    ];
    const operationResults = await Promise.allSettled(operations);
    const capacitySample = this.capacitySamples.pending();
    const capacityResults = await Promise.allSettled(
      capacitySample === undefined ? [] : [capacitySample],
    );
    const settlementResults = await Promise.allSettled(
      this.publicationSettlements.pendingSettlements(),
    );
    return [
      ...operationResults,
      ...capacityResults,
      ...settlementResults,
    ].flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
  }

  private async publishAndSettle(
    event: LeasedOutboxEvent,
  ): Promise<OutboxPublicationOutcome> {
    let jobObservation: TransportJob | undefined;
    let queuePublished = false;
    try {
      jobObservation = transportJobName(event.jobName);
      const job = toQueueJob(event);
      const currentJob = transportJobForName(job.name);
      jobObservation = currentJob;
      const publication = await this.producer.publish(job);
      if (publication.outcome === 'outcome_unknown') {
        observeDispatchMetrics(() => {
          this.metrics.recordOutboxPublish({
            ...currentJob,
            errorClass: 'timeout',
            outcome: 'outcome_unknown',
          });
        });
        this.publicationSettlements.track(event, publication.settlement);
        return 'outcome_unknown';
      }
      queuePublished = true;
      observeDispatchMetrics(() => {
        this.metrics.recordOutboxPublish({
          ...currentJob,
          outcome: 'published',
        });
      });
      return await this.settlePublished(event, job.name, currentJob);
    } catch (error: unknown) {
      if (jobObservation !== undefined && !queuePublished) {
        const failedJob = jobObservation;
        observeDispatchMetrics(() => {
          this.metrics.recordOutboxPublish({
            ...failedJob,
            errorClass: transportErrorClass(error),
            outcome: 'failed',
          });
        });
      }
      await this.releaseFailedPublication(event, error);
      return 'failed';
    }
  }

  private async settlePublished(
    event: LeasedOutboxEvent,
    jobName: JobName,
    job: TransportJob,
  ): Promise<OutboxPublicationOutcome> {
    const marked = await this.publicationSettlements.markPublished(event);
    if (marked === 'outcome_unknown') return marked;
    observeDispatchMetrics(() => {
      this.metrics.recordOutboxDispatchLatency({
        ...job,
        durationSeconds: Math.max(
          0,
          (Date.now() - event.availableAt.getTime()) / 1_000,
        ),
        outcome: marked ? 'published' : 'stale',
      });
    });
    if (!marked) {
      observeDispatchMetrics(() => {
        this.metrics.recordOutboxLeaseEvent('expired');
      });
    } else if (jobName === JOB_NAME.advanceWorkflowRun) {
      this.capacitySamples.schedule(event.workspaceId);
    }
    return marked ? 'published' : 'stale';
  }

  private async releaseFailedPublication(
    event: LeasedOutboxEvent,
    error: unknown,
  ): Promise<void> {
    const releaseResult = await bounded(
      this.database.releaseOrFail({
        errorCode: errorCode(error),
        id: event.id,
        leaseToken: event.leaseToken,
        maxAttempts: this.options.maxAttempts,
        retryAt: new Date(Date.now() + this.options.retryDelayMillis),
      }),
      this.options.operationTimeoutMillis,
    );
    if (releaseResult === 'failed') {
      observeDispatchMetrics(() => {
        this.metrics.recordOutboxLeaseEvent('attempt_exhausted');
      });
    } else if (releaseResult === 'not_leased') {
      observeDispatchMetrics(() => {
        this.metrics.recordOutboxLeaseEvent('expired');
      });
    }
  }

  private async runLoop(): Promise<void> {
    const activePollIntervalMillis = Math.min(
      ACTIVE_POLL_INTERVAL_MILLIS,
      this.options.pollIntervalMillis,
    );
    let polling: DispatchPollingState = {
      intervalMillis: this.options.pollIntervalMillis,
      lastActivityAt: Number.NEGATIVE_INFINITY,
    };
    while (this.isRunning() && this.drainState.canAcceptWork()) {
      try {
        const result = await this.dispatchOnce();
        const now = performance.now();
        // Successive steps need successive publications. Keep those rounds
        // close together without imposing busy polling on an idle workspace.
        polling = nextDispatchPolling(polling, result, {
          now,
          activeIntervalMillis: activePollIntervalMillis,
          idleIntervalMillis: this.options.pollIntervalMillis,
        });
      } catch {
        // Readiness surfaces boundary health. The loop stays alive so a
        // transient PostgreSQL/Redis failure cannot permanently stop dispatch.
        polling = {
          lastActivityAt: Number.NEGATIVE_INFINITY,
          intervalMillis: this.options.pollIntervalMillis,
        };
      }
      if (!this.isRunning() || !this.drainState.canAcceptWork()) break;
      await new Promise<void>((resolve) => {
        if (!this.isRunning()) {
          resolve();
          return;
        }
        let settled = false;
        const timer = setTimeout(resolve, polling.intervalMillis);
        const wake = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        this.wakeLoop = wake;
        if (!this.isRunning()) wake();
      });
      this.wakeLoop = undefined;
    }
  }

  private assertOpen(): void {
    if (this.lifecycle === 'closed') throw new OutboxDispatcherClosedError();
  }

  private isRunning(): boolean {
    return this.lifecycle === 'running';
  }
}
