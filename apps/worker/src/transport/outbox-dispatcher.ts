import { randomUUID } from 'node:crypto';

import { canonicalOutboxPayloadChecksum } from '@pertexo/database/execution';
import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
} from '@pertexo/database/execution';
import {
  createTransportMetrics,
  type TransportErrorClass,
  type TransportJob,
  type TransportMetrics,
} from '@pertexo/observability/transport-metrics';
import {
  JOB_NAME,
  QUEUE_FOR_JOB,
  QueueNotReadyError,
  parseQueueJob,
  type QueueJob,
  type JobName,
  type QueueProducer,
} from '@pertexo/queue';
import { z } from 'zod';

import { isSupportedDispatchCapability } from '../config/worker-config.js';
import type { WorkerDrainState } from '../runtime/worker-drain-state.js';
import {
  DispatchConsumerCapabilityError,
  NO_DISPATCH_CONSUMER_CAPABILITIES,
  type DispatchConsumerCapabilityRegistry,
} from './dispatch-consumer-capabilities.js';
import { transportJobForName } from './transport-job.js';
import { OutboxPublicationSettlements } from './outbox-publication-settlements.js';
import {
  bounded,
  TransportOperationTimeoutError,
} from './transport-operation-deadline.js';

const optionsSchema = z
  .object({
    batchSize: z.number().int().min(1).max(100),
    enabledJobNames: z
      .array(z.enum(JOB_NAME))
      .refine((values) => new Set(values).size === values.length)
      .refine((values) => values.every(isSupportedDispatchCapability)),
    leaseDurationMillis: z.number().int().min(1_000).max(300_000),
    leaseOwner: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    maxAttempts: z.number().int().min(1).max(1_000),
    operationTimeoutMillis: z
      .number()
      .int()
      .min(100)
      .max(120_000)
      .default(5_000),
    pollIntervalMillis: z.number().int().min(10).max(60_000).default(250),
    retryDelayMillis: z.number().int().min(1).max(300_000),
  })
  .strict();

export type OutboxDispatcherOptions = Readonly<
  Omit<z.input<typeof optionsSchema>, 'enabledJobNames'> & {
    enabledJobNames: readonly JobName[];
  }
>;

export type OutboxDispatcherRuntimeHooks = Readonly<{
  observeWorkspaceCapacity(workspaceId: string): Promise<void>;
}>;

export type OutboxDispatchResult = Readonly<{
  claimed: number;
  failed: number;
  outcomeUnknown: number;
  published: number;
  stale: number;
}>;

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

const transportJobNameSchema = z.enum(JOB_NAME);
const WORKSPACE_CAPACITY_SAMPLE_INTERVAL_MILLIS = 5 * 60_000;
const MAX_TRACKED_WORKSPACE_CAPACITY_SAMPLES = 1_000;
const MAX_PENDING_WORKSPACE_CAPACITY_SAMPLES = 100;

function transportJob(job: QueueJob): TransportJob {
  return transportJobForName(job.name);
}

function transportJobName(jobName: string): TransportJob | undefined {
  const parsed = transportJobNameSchema.safeParse(jobName);
  return parsed.success ? transportJobForName(parsed.data) : undefined;
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
        schemaVersion: event.schemaVersion,
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
  private readonly options: Readonly<
    Omit<z.output<typeof optionsSchema>, 'enabledJobNames'> & {
      enabledJobNames: readonly JobName[];
    }
  >;
  private readonly enabledQueueNames: ReadonlySet<string>;
  private readonly capacitySampledAtByWorkspace = new Map<string, number>();
  private readonly pendingCapacityWorkspaces = new Set<string>();
  private capacitySamplerPromise: Promise<void> | undefined;
  private readonly publicationSettlements: OutboxPublicationSettlements;
  private runtimeHooks: OutboxDispatcherRuntimeHooks | undefined;
  private lifecycle: 'idle' | 'running' | 'closed' = 'idle';
  private loopPromise: Promise<void> | undefined;
  private wakeLoop: (() => void) | undefined;

  public constructor(
    private readonly database: OutboxDispatcherDatabase,
    private readonly producer: QueueProducer,
    private readonly drainState: WorkerDrainState,
    options: OutboxDispatcherOptions,
    private readonly metrics: TransportMetrics = createTransportMetrics(),
    private readonly consumerCapabilities: DispatchConsumerCapabilityRegistry = NO_DISPATCH_CONSUMER_CAPABILITIES,
  ) {
    const parsed = optionsSchema.parse({
      ...options,
      enabledJobNames: [...options.enabledJobNames],
    });
    this.options = Object.freeze({
      ...parsed,
      enabledJobNames: Object.freeze([...parsed.enabledJobNames]),
    });
    this.publicationSettlements = new OutboxPublicationSettlements(
      database,
      this.options.operationTimeoutMillis,
    );
    this.enabledQueueNames = new Set(
      this.options.enabledJobNames.map(
        (jobName: JobName) => QUEUE_FOR_JOB[jobName],
      ),
    );
  }

  public start(): void {
    this.assertOpen();
    if (this.lifecycle === 'running') return;
    this.lifecycle = 'running';
    this.loopPromise = this.runLoop();
  }

  public configureRuntimeHooks(hooks: OutboxDispatcherRuntimeHooks): void {
    this.assertOpen();
    if (this.lifecycle !== 'idle' || this.runtimeHooks !== undefined) {
      throw new Error('Outbox dispatcher runtime hooks are already configured');
    }
    this.runtimeHooks = Object.freeze(hooks);
  }

  public async dispatchOnce(): Promise<OutboxDispatchResult> {
    this.assertOpen();
    if (!this.drainState.canAcceptWork()) return EMPTY_RESULT;
    if (this.options.enabledJobNames.length === 0) return EMPTY_RESULT;
    const enabledJobNames = this.assertConsumerCapabilitiesReady();

    const claim = await this.database.claimBatch({
      enabledJobNames,
      leaseDurationMillis: this.options.leaseDurationMillis,
      leaseOwner: this.options.leaseOwner,
      leaseToken: randomUUID(),
      limit: this.options.batchSize,
      maxAttempts: this.options.maxAttempts,
    });
    const { events } = claim;
    this.observeMetrics(() => {
      this.metrics.recordOutboxClaim({ batchSize: events.length });
      if (claim.exhaustedCount > 0) {
        this.metrics.recordOutboxLeaseEvent(
          'attempt_exhausted',
          claim.exhaustedCount,
        );
      }
      for (const event of events) {
        if (event.publishAttempts > 1) {
          this.metrics.recordOutboxLeaseEvent('reclaimed');
        }
      }
    });
    const outcomes = await Promise.all(
      events.map((event) => this.dispatch(event)),
    );
    await Promise.all([this.observeOutbox(), this.observeQueues()]);

    return Object.freeze({
      claimed: events.length,
      failed: outcomes.filter((outcome) => outcome === 'failed').length,
      outcomeUnknown: outcomes.filter(
        (outcome) => outcome === 'outcome_unknown',
      ).length,
      published: outcomes.filter((outcome) => outcome === 'published').length,
      stale: outcomes.filter((outcome) => outcome === 'stale').length,
    });
  }

  public async checkReadiness(): Promise<void> {
    this.assertOpen();
    if (!this.drainState.canAcceptWork()) {
      throw new Error('Outbox dispatcher is draining');
    }
    await Promise.all([
      this.database.checkReadiness(),
      this.producer.waitUntilReady(),
      this.consumerCapabilities.assertReady(this.options.enabledJobNames),
    ]);
  }

  public async close(): Promise<void> {
    if (this.lifecycle === 'closed') return;
    this.lifecycle = 'closed';
    this.pendingCapacityWorkspaces.clear();
    this.wakeLoop?.();
    const loopResults = await Promise.allSettled([
      this.loopPromise === undefined
        ? Promise.resolve()
        : bounded(this.loopPromise, this.options.operationTimeoutMillis),
      this.capacitySamplerPromise === undefined
        ? Promise.resolve()
        : bounded(
            this.capacitySamplerPromise,
            this.options.operationTimeoutMillis,
          ),
      ...this.publicationSettlements.boundedPending(),
    ]);
    const closeResults = await Promise.allSettled([
      bounded(this.database.close(), this.options.operationTimeoutMillis),
      bounded(this.producer.close(), this.options.operationTimeoutMillis),
    ]);
    const results = [...loopResults, ...closeResults];
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejection !== undefined) throw rejection.reason;
  }

  private async dispatch(
    event: LeasedOutboxEvent,
  ): Promise<'failed' | 'outcome_unknown' | 'published' | 'stale'> {
    let jobObservation: TransportJob | undefined;
    let queuePublished = false;
    try {
      jobObservation = transportJobName(event.jobName);
      const job = toQueueJob(event);
      const currentJob = transportJob(job);
      jobObservation = currentJob;
      const publication = await this.producer.publish(job);
      if (publication.outcome === 'outcome_unknown') {
        this.observeMetrics(() => {
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
      this.observeMetrics(() => {
        this.metrics.recordOutboxPublish({
          ...currentJob,
          outcome: 'published',
        });
      });
      const marked = await bounded(
        this.database.markPublished(event.id, event.leaseToken),
        this.options.operationTimeoutMillis,
      );
      this.observeMetrics(() => {
        this.metrics.recordOutboxDispatchLatency({
          ...currentJob,
          durationSeconds: Math.max(
            0,
            (Date.now() - event.availableAt.getTime()) / 1_000,
          ),
          outcome: marked ? 'published' : 'stale',
        });
      });
      if (!marked) {
        this.observeMetrics(() => {
          this.metrics.recordOutboxLeaseEvent('expired');
        });
      } else if (
        job.name === JOB_NAME.advanceWorkflowRun ||
        job.name === JOB_NAME.expireArtifacts
      ) {
        this.scheduleWorkspaceCapacityObservation(event.workspaceId);
      }
      return marked ? 'published' : 'stale';
    } catch (error: unknown) {
      if (jobObservation !== undefined && !queuePublished) {
        const failedJob = jobObservation;
        this.observeMetrics(() => {
          this.metrics.recordOutboxPublish({
            ...failedJob,
            errorClass: transportErrorClass(error),
            outcome: 'failed',
          });
        });
      }
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
        this.observeMetrics(() => {
          this.metrics.recordOutboxLeaseEvent('attempt_exhausted');
        });
      } else if (releaseResult === 'not_leased') {
        this.observeMetrics(() => {
          this.metrics.recordOutboxLeaseEvent('expired');
        });
      }
      return 'failed';
    }
  }

  private async runLoop(): Promise<void> {
    while (this.lifecycle === 'running' && this.drainState.canAcceptWork()) {
      try {
        await this.dispatchOnce();
      } catch {
        // Readiness surfaces boundary health. The loop stays alive so a
        // transient PostgreSQL/Redis failure cannot permanently stop dispatch.
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.pollIntervalMillis);
        this.wakeLoop = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeLoop = undefined;
    }
  }

  private assertOpen(): void {
    if (this.lifecycle === 'closed') throw new OutboxDispatcherClosedError();
  }

  private assertConsumerCapabilitiesReady(): readonly JobName[] {
    const readyJobNames = new Set(this.consumerCapabilities.readyJobNames());
    for (const jobName of this.options.enabledJobNames) {
      if (!readyJobNames.has(jobName)) {
        throw new DispatchConsumerCapabilityError(jobName);
      }
    }
    return this.options.enabledJobNames;
  }

  private observeMetrics(observe: () => void): void {
    try {
      observe();
    } catch {
      // Operational telemetry cannot alter durable dispatch behavior.
    }
  }

  private async observeWorkspaceCapacity(workspaceId: string): Promise<void> {
    if (this.runtimeHooks === undefined) return;
    try {
      await bounded(
        this.runtimeHooks.observeWorkspaceCapacity(workspaceId),
        this.options.operationTimeoutMillis,
      );
    } catch {
      // Capacity telemetry cannot alter durable publication acknowledgement.
    }
  }

  private scheduleWorkspaceCapacityObservation(workspaceId: string): void {
    if (this.runtimeHooks === undefined) return;
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
      while (this.lifecycle !== 'closed') {
        const workspaceId = this.pendingCapacityWorkspaces
          .values()
          .next().value;
        if (workspaceId === undefined) return;
        this.pendingCapacityWorkspaces.delete(workspaceId);
        await this.observeWorkspaceCapacity(workspaceId);
      }
    } finally {
      this.capacitySamplerPromise = undefined;
    }
  }

  private async observeQueues(): Promise<void> {
    try {
      const observations = await bounded(
        this.producer.observe(),
        this.options.operationTimeoutMillis,
      );
      this.observeMetrics(() => {
        for (const observation of observations) {
          if (this.enabledQueueNames.has(observation.queueName)) {
            this.metrics.observeQueue(observation);
          }
        }
      });
    } catch {
      // Queue-state telemetry is best-effort and cannot fail dispatch.
    }
  }

  private async observeOutbox(): Promise<void> {
    try {
      const observation = await bounded(
        this.database.observeBacklog({
          enabledJobNames: this.options.enabledJobNames,
        }),
        this.options.operationTimeoutMillis,
      );
      this.observeMetrics(() => {
        this.metrics.observeOutbox(observation);
      });
    } catch {
      // Backlog telemetry is best-effort and cannot fail dispatch.
    }
  }
}
