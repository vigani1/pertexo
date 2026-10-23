import { z } from 'zod';

import { QUEUE_CLASS_DEFAULTS } from '../jobs/defaults.js';
import { QUEUE_NAME } from '../jobs/names.js';

import { createProductionRedisTelemetryObserver } from '../redis/telemetry.js';
import { normalizeRedisEndpoint } from '../redis/endpoint.js';
import type {
  QueueConsumerOptions,
  ParsedConsumerOptions,
} from './contract.js';
import { QueueConsumerConfigurationError } from './errors.js';

const DEFAULT_READY_TIMEOUT_MS = 5_000;

const MAX_CONFIGURED_TIMEOUT_MS = 60 * 60_000;

const consumerOptionsSchema = z
  .object({
    queueName: z.enum([
      QUEUE_NAME.workflowCoordinator,
      QUEUE_NAME.nodeAttempts,
      QUEUE_NAME.triggerLifecycle,
      QUEUE_NAME.maintenance,
    ]),
    redisUrl: z.string().trim().min(1),
    readyTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_CONFIGURED_TIMEOUT_MS)
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_CONFIGURED_TIMEOUT_MS)
      .optional(),
    drainTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_CONFIGURED_TIMEOUT_MS)
      .optional(),
  })
  .strict();

function parseRedisUrl(value: string): string {
  return normalizeRedisEndpoint(
    value,
    (reason) =>
      new QueueConsumerConfigurationError(
        reason === 'invalid_url'
          ? 'Redis URL is invalid'
          : 'Redis URL must use redis:// or rediss:// with a hostname',
      ),
  );
}

export function parseConsumerOptions(
  options: QueueConsumerOptions,
): ParsedConsumerOptions {
  const candidate = {
    queueName: options.queueName,
    redisUrl: options.redisUrl,
    readyTimeoutMs: options.readyTimeoutMs,
    timeoutMs: options.timeoutMs,
    drainTimeoutMs: options.drainTimeoutMs,
  };
  const parsed = consumerOptionsSchema.safeParse(candidate);

  const invalidConsumerOptions =
    !parsed.success ||
    typeof options.handler !== 'function' ||
    (options.observer !== undefined &&
      (typeof options.observer !== 'object' ||
        typeof options.observer.handlerStarted !== 'function' ||
        typeof options.observer.handlerFinished !== 'function')) ||
    (options.traceRunner !== undefined &&
      (typeof options.traceRunner !== 'object' ||
        typeof options.traceRunner.run !== 'function'));
  if (invalidConsumerOptions) {
    throw new QueueConsumerConfigurationError(
      'Queue consumer configuration is invalid',
    );
  }

  const defaults = QUEUE_CLASS_DEFAULTS[parsed.data.queueName];
  return {
    queueName: parsed.data.queueName,
    redisUrl: parseRedisUrl(parsed.data.redisUrl),
    handler: options.handler,
    observer: options.observer,
    redisTelemetry:
      options.redisTelemetry ?? createProductionRedisTelemetryObserver(),
    traceRunner: options.traceRunner,
    readyTimeoutMs: parsed.data.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    timeoutMs: parsed.data.timeoutMs ?? defaults.timeoutMs,
    drainTimeoutMs: parsed.data.drainTimeoutMs ?? defaults.drainTimeoutMs,
  };
}
