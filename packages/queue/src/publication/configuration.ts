import { z } from 'zod';

import { normalizeRedisEndpoint } from '../redis/endpoint.js';
import type { QueueProducerOptions } from './contract.js';
import { QueueConfigurationError } from './errors.js';

const DEFAULT_READY_TIMEOUT_MS = 5_000;

const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

const queueProducerOptionsSchema = z
  .object({
    redisUrl: z.string().trim().min(1),
    readyTimeoutMs: z.number().int().positive().max(120_000).optional(),
    publishTimeoutMs: z.number().int().positive().max(120_000).optional(),
    closeTimeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();

function parseRedisUrl(value: string): string {
  return normalizeRedisEndpoint(
    value,
    (reason) =>
      new QueueConfigurationError(
        reason === 'invalid_url'
          ? 'Redis URL is invalid'
          : 'Redis URL must use redis:// or rediss:// with a hostname',
      ),
  );
}

export function parseProducerOptions(options: QueueProducerOptions): {
  readonly redisUrl: string;
  readonly readyTimeoutMs: number;
  readonly publishTimeoutMs: number;
  readonly closeTimeoutMs: number;
} {
  const parsed = queueProducerOptionsSchema.safeParse({
    publishTimeoutMs: options.publishTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    readyTimeoutMs: options.readyTimeoutMs,
    redisUrl: options.redisUrl,
  });

  if (!parsed.success) {
    throw new QueueConfigurationError('Redis URL configuration is invalid');
  }

  return {
    redisUrl: parseRedisUrl(parsed.data.redisUrl),
    readyTimeoutMs: parsed.data.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    publishTimeoutMs:
      parsed.data.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
    closeTimeoutMs: parsed.data.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
  };
}
