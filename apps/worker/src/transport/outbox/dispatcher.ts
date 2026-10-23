import { randomUUID } from 'node:crypto';

import { canonicalOutboxPayloadChecksum } from '@pertexo/database/outbox';
import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
} from '@pertexo/database/outbox';
import {
  createTransportMetrics,
  type TransportErrorClass,
  type TransportJob,
  type TransportMetrics,
} from '@pertexo/observability';
import {
  JOB_NAME,
  QUEUE_FOR_JOB,
  QueueNotReadyError,
  parseQueueJob,
  type QueueJob,
  type JobName,
  type QueueProducer,
} from '@pertexo/queue';

import type { WorkerDrainState } from '../../runtime/shutdown/drain-state.js';
import { transportJobForName } from '../job.js';
import { OutboxPublicationSettlements } from './publication-settlements.js';
import {
  recordOutboxClaim,
  summarizeDispatchOutcomes,
  type OutboxDispatchResult as InternalOutboxDispatchResult,
  type OutboxPublicationOutcome,
} from './dispatch-result.js';
import {
  bounded,
  TransportOperationTimeoutError,
} from './operation-deadline.js';

/** Bounds are validated once, by the worker config. */
export type OutboxDispatcherOptions = Readonly<{
  batchSize: number;
  /** The job kinds this worker consumes; only those are dispatched. */
  jobNames: readonly JobName[];
  leaseDurationMillis: number;
  leaseOwner: string;
  maxAttempts: number;
  operationTimeoutMillis?: number;
  /** Maximum interval while idle; publication shortens subsequent polling. */
  pollIntervalMillis?: number;
  retryDelayMillis: number;
}>;

export type OutboxDispatcherRuntimeHooks = Readonly<{
  observeWorkspaceCapacity(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<void>;
}>;

export type OutboxDispatchResult = InternalOutboxDispatchResult;

export class OutboxPayloadChecksumError extends Error {
  public constructor(eventId: string) {
    super(`Outbox event ${eventId} has an invalid payload checksum`);
    this.name = 'OutboxPayloadChecksumError';
  }
}

class OutboxContractError extends Error {
  public constructor(eventId: string, cause: unknown) {
    super(`Outbox event ${eventId} does not match a queue contract`, { cause });
    this.name = 'OutboxContractError';
  }
}

class OutboxDispatcherClosedError extends Error {
  public constructor() {
    super('Outbox dispatcher is closed');
    this.name = 'OutboxDispatcherClosedError';
  }
}

const WORKSPACE_CAPACITY_SAMPLE_INTERVAL_MILLIS = 5 * 60_000;
const MAX_TRACKED_WORKSPACE_CAPACITY_SAMPLES = 1_000;
const MAX_PENDING_WORKSPACE_CAPACITY_SAMPLES = 100;
const ACTIVE_POLL_INTERVAL_MILLIS = 25;
// A run's next step reaches the outbox a few dozen milliseconds after its
// previous publication, two hops per step. Polling quickly for this long after
// the last publication keeps those hops from each waiting out a backed-off
// interval; an idle worker still backs off once it passes.
const ACTIVE_WINDOW_MILLIS = 1_000;

function transportJobName(jobName: string): TransportJob | undefined {
  return Object.values<string>(JOB_NAME).includes(jobName)
    ? transportJobForName(jobName as JobName)
    : undefined;
}

function transportErrorClass(error: unknown): TransportErrorClass {
  if (
    error instanceof OutboxPayloadChecksumError ||
    error instanceof OutboxContractError
  ) {
    return 'contract';
  }
  if (error instanceof TransportOperationTimeoutError) {
    return 'timeout';
  }
  if (error instanceof QueueNotReadyError) {
    return 'unavailable';
  }
  return 'redis';
}

function toQueueJob(event: LeasedOutboxEvent): QueueJob {
  if (canonicalOutboxPayloadChecksum(event.payload) !== event.payloadChecksum) {
    throw new OutboxPayloadChecksumError(event.id);
  }
  if (
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    throw new OutboxContractError(
      event.id,
      new TypeError('Payload is not an object'),
    );
  }

  try {
    return parseQueueJob({
      name: event.jobName,
      data: {
        ...event.payload,
        outboxEventId: event.id,
        workspaceId: event.workspaceId,
      },
    });
  } catch (error: unknown) {
    throw new OutboxContractError(event.id, error);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof OutboxPayloadChecksumError) {
    return 'outbox.checksum_mismatch';
  }
  if (error instanceof OutboxContractError) {
    return 'outbox.invalid_contract';
  }
  return 'queue.publish_failed';
}

const EMPTY_RESULT: OutboxDispatchResult = Object.freeze({
  claimed: 0,
  failed: 0,
  outcomeUnknown: 0,
  published: 0,
  stale: 0,
});

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
    this.drainState = drainState;
    this.metrics = metrics;

    this.options = Object.freeze({
      operationTimeoutMillis: 5_000,
      pollIntervalMillis: 250,
      ...options,
      jobNames: Object.freeze([...options.jobNames]),
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

function observeDispatchMetrics(observe: () => void): void {
  try {
    observe();
  } catch {
    // Operational telemetry cannot alter durable dispatch behavior.
  }
}

async function observeDispatchQueues(
  producer: QueueProducer,
  metrics: TransportMetrics,
  {
    timeoutMillis,
    enabledQueueNames,
  }: Readonly<{
    timeoutMillis: number;
    enabledQueueNames: ReadonlySet<string>;
  }>,
): Promise<void> {
  try {
    const observations = await bounded(producer.observe(), timeoutMillis);
    observeDispatchMetrics(() => {
      for (const observation of observations) {
        if (enabledQueueNames.has(observation.queueName)) {
          metrics.observeQueue(observation);
        }
      }
    });
  } catch {
    // Queue-state telemetry is best-effort and cannot fail dispatch.
  }
}

async function observeDispatchBacklog(
  database: OutboxDispatcherDatabase,
  metrics: TransportMetrics,
  {
    timeoutMillis,
    jobNames,
  }: Readonly<{ timeoutMillis: number; jobNames: readonly JobName[] }>,
): Promise<void> {
  try {
    const observation = await bounded(
      database.observeBacklog({
        enabledJobNames: jobNames,
      }),
      timeoutMillis,
    );
    observeDispatchMetrics(() => {
      metrics.observeOutbox(observation);
    });
  } catch {
    // Backlog telemetry is best-effort and cannot fail dispatch.
  }
}

async function observeDispatchCapacity(
  hooks: OutboxDispatcherRuntimeHooks | undefined,
  workspaceId: string,
  timeoutMillis: number,
): Promise<void> {
  if (hooks === undefined) return;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new TransportOperationTimeoutError(timeoutMillis));
  }, timeoutMillis);
  timer.unref();
  try {
    await hooks.observeWorkspaceCapacity(workspaceId, controller.signal);
  } catch {
    // Capacity telemetry cannot alter durable publication acknowledgement.
  } finally {
    clearTimeout(timer);
  }
}

async function closeDispatcherDependencies(
  database: OutboxDispatcherDatabase,
  producer: QueueProducer,
  {
    timeoutMillis,
    earlierFailures,
  }: Readonly<{ timeoutMillis: number; earlierFailures: readonly unknown[] }>,
): Promise<void> {
  const results = await Promise.allSettled([
    bounded(
      Promise.resolve().then(() => database.close()),
      timeoutMillis,
    ),
    bounded(
      Promise.resolve().then(() => producer.close()),
      timeoutMillis,
    ),
  ]);
  const failures = [
    ...earlierFailures,
    ...results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    ),
  ];
  if (failures.length > 0)
    throw new AggregateError(failures, 'Outbox dispatcher shutdown failed');
}

interface DispatchPollingState {
  readonly intervalMillis: number;
  readonly lastActivityAt: number;
}
function nextDispatchPolling(
  previous: DispatchPollingState,
  result: OutboxDispatchResult,
  {
    now,
    activeIntervalMillis,
    idleIntervalMillis,
  }: Readonly<{
    now: number;
    activeIntervalMillis: number;
    idleIntervalMillis: number;
  }>,
): DispatchPollingState {
  if (result.published > 0 || result.outcomeUnknown > 0)
    return { lastActivityAt: now, intervalMillis: activeIntervalMillis };
  if (result.failed > 0)
    return {
      lastActivityAt: Number.NEGATIVE_INFINITY,
      intervalMillis: idleIntervalMillis,
    };
  if (now - previous.lastActivityAt < ACTIVE_WINDOW_MILLIS)
    return {
      lastActivityAt: previous.lastActivityAt,
      intervalMillis: activeIntervalMillis,
    };
  return {
    lastActivityAt: previous.lastActivityAt,
    intervalMillis: Math.min(previous.intervalMillis * 2, idleIntervalMillis),
  };
}

class OutboxCapacitySampler {
  private readonly capacitySampledAtByWorkspace = new Map<string, number>();
  private readonly pendingCapacityWorkspaces = new Set<string>();
  private capacitySamplerPromise: Promise<void> | undefined;
  private runtimeHooks: OutboxDispatcherRuntimeHooks | undefined;
  private closed = false;
  public constructor(private readonly operationTimeoutMillis: number) {}
  public get configured(): boolean {
    return this.runtimeHooks !== undefined;
  }
  public configure(hooks: OutboxDispatcherRuntimeHooks): void {
    this.runtimeHooks = hooks;
  }
  public stop(): void {
    this.closed = true;
    this.pendingCapacityWorkspaces.clear();
  }
  public pending(): Promise<void> | undefined {
    return this.capacitySamplerPromise;
  }
  public schedule(workspaceId: string): void {
    if (this.runtimeHooks === undefined || this.closed) return;
    const now = Date.now();
    const sampledAt = this.capacitySampledAtByWorkspace.get(workspaceId);
    if (
      sampledAt !== undefined &&
      now - sampledAt < WORKSPACE_CAPACITY_SAMPLE_INTERVAL_MILLIS
    )
      return;
    if (
      this.pendingCapacityWorkspaces.size >=
      MAX_PENDING_WORKSPACE_CAPACITY_SAMPLES
    )
      return;

    if (
      this.capacitySampledAtByWorkspace.size >=
      MAX_TRACKED_WORKSPACE_CAPACITY_SAMPLES
    ) {
      const oldestWorkspace = this.capacitySampledAtByWorkspace
        .keys()
        .next().value;
      if (oldestWorkspace !== undefined)
        this.capacitySampledAtByWorkspace.delete(oldestWorkspace);
    }
    this.capacitySampledAtByWorkspace.set(workspaceId, now);
    this.pendingCapacityWorkspaces.add(workspaceId);
    this.capacitySamplerPromise ??= this.drainWorkspaceCapacitySamples();
  }
  private async drainWorkspaceCapacitySamples(): Promise<void> {
    try {
      while (!this.closed) {
        const workspaceId = this.pendingCapacityWorkspaces
          .values()
          .next().value;
        if (workspaceId === undefined) return;
        this.pendingCapacityWorkspaces.delete(workspaceId);
        await observeDispatchCapacity(
          this.runtimeHooks,
          workspaceId,
          this.operationTimeoutMillis,
        );
      }
    } finally {
      this.capacitySamplerPromise = undefined;
    }
  }
}
