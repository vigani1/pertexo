import './server-only.js';

import { QUEUE_NAME, type QueueName } from './names.js';

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

export interface QueueClassJobDefaults {
  /** Transport redelivery only; business retries remain PostgreSQL-owned. */
  readonly attempts: number;
  readonly backoff: {
    readonly type: 'fixed';
    readonly delay: number;
  };
  readonly lockDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly stalledIntervalMs: number;
  readonly maxStalledCount: number;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly drainTimeoutMs: number;
  readonly removeOnComplete: {
    readonly age: number;
    readonly count: number;
  };
  readonly removeOnFail: {
    readonly age: number;
    readonly count: number;
  };
}

const freezeDefaults = (
  defaults: QueueClassJobDefaults,
): QueueClassJobDefaults =>
  Object.freeze({
    ...defaults,
    backoff: Object.freeze({ ...defaults.backoff }),
    removeOnComplete: Object.freeze({ ...defaults.removeOnComplete }),
    removeOnFail: Object.freeze({ ...defaults.removeOnFail }),
  });

export const QUEUE_CLASS_DEFAULTS = Object.freeze({
  [QUEUE_NAME.workflowCoordinator]: freezeDefaults({
    attempts: 3,
    backoff: { type: 'fixed', delay: 1_000 },
    lockDurationMs: 30_000,
    heartbeatIntervalMs: 15_000,
    stalledIntervalMs: 30_000,
    maxStalledCount: 1,
    timeoutMs: 60_000,
    concurrency: 16,
    drainTimeoutMs: 30_000,
    removeOnComplete: { age: DAY_SECONDS, count: 1_000 },
    removeOnFail: { age: 30 * DAY_SECONDS, count: 10_000 },
  }),
  [QUEUE_NAME.nodeAttempts]: freezeDefaults({
    attempts: 3,
    backoff: { type: 'fixed', delay: 1_000 },
    lockDurationMs: 5 * 60_000,
    heartbeatIntervalMs: 2 * 60_000,
    stalledIntervalMs: 60_000,
    maxStalledCount: 1,
    timeoutMs: 15 * 60_000,
    concurrency: 32,
    drainTimeoutMs: 60_000,
    removeOnComplete: { age: DAY_SECONDS, count: 10_000 },
    removeOnFail: { age: 30 * DAY_SECONDS, count: 100_000 },
  }),
  [QUEUE_NAME.triggerLifecycle]: freezeDefaults({
    attempts: 3,
    backoff: { type: 'fixed', delay: 1_000 },
    lockDurationMs: 2 * 60_000,
    heartbeatIntervalMs: 60_000,
    stalledIntervalMs: 60_000,
    maxStalledCount: 1,
    timeoutMs: 5 * 60_000,
    concurrency: 8,
    drainTimeoutMs: 30_000,
    removeOnComplete: { age: 7 * DAY_SECONDS, count: 5_000 },
    removeOnFail: { age: 30 * DAY_SECONDS, count: 10_000 },
  }),
  [QUEUE_NAME.maintenance]: freezeDefaults({
    attempts: 3,
    backoff: { type: 'fixed', delay: 1_000 },
    lockDurationMs: 2 * 60_000,
    heartbeatIntervalMs: 60_000,
    stalledIntervalMs: 60_000,
    maxStalledCount: 1,
    timeoutMs: 10 * 60_000,
    concurrency: 4,
    drainTimeoutMs: 60_000,
    removeOnComplete: { age: 7 * DAY_SECONDS, count: 5_000 },
    removeOnFail: { age: 30 * DAY_SECONDS, count: 10_000 },
  }),
} as const satisfies Record<QueueName, QueueClassJobDefaults>);
