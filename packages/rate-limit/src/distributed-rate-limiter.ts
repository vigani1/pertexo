import { createHash } from 'node:crypto';

import {
  RATE_LIMIT_ENDPOINT_CLASSES,
  type RateLimitDecision,
  type RateLimitDimensionKind,
} from './policy.js';

export type RateLimitScriptExecutor = Readonly<{
  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: string[]
  ): Promise<unknown>;
}>;

/** What's left of the tightest budget a request counts against. */
export type RateLimitQuota = Readonly<{
  limit: number;
  remaining: number;
  resetSeconds: number;
}>;

export type DistributedRateLimitResult =
  | Readonly<{ allowed: true; quota?: RateLimitQuota }>
  | Readonly<{
      allowed: false;
      retryAfterSeconds: number;
      limitedDimension: RateLimitDimensionKind;
    }>;

const CONSUME_SCRIPT = `
local window_ms = tonumber(ARGV[1])
local rejected_index = 0
local retry_ms = 0

for index, key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  local limit = tonumber(ARGV[index + 1])
  if count >= limit then
    rejected_index = index
    local ttl = redis.call('PTTL', key)
    if ttl < 1 then ttl = window_ms end
    if ttl > retry_ms then retry_ms = ttl end
  end
end

if rejected_index > 0 then
  return {0, retry_ms, rejected_index}
end

local remaining
local tightest = 0
local reset_ms = 0
for index, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('PEXPIRE', key, window_ms) end
  local limit = tonumber(ARGV[index + 1])
  if remaining == nil or limit - count < remaining then
    remaining = limit - count
    tightest = limit
    reset_ms = redis.call('PTTL', key)
  end
end

return {1, 0, 0, remaining, tightest, reset_ms}
`;

const MAX_WINDOW_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

function counterKey(decision: RateLimitDecision, index: number): string {
  const dimension = decision.dimensions[index];
  if (dimension === undefined) {
    throw new RangeError('Rate-limit dimension index is out of bounds');
  }
  const digest = createHash('sha256')
    .update(decision.endpointClass)
    .update('\0')
    .update(dimension.kind)
    .update('\0')
    .update(dimension.identifier)
    .digest('hex');
  return `pertexo:abuse:${decision.endpointClass}:${dimension.kind}:${digest}`;
}

function assertDecision(decision: RateLimitDecision): void {
  if (!RATE_LIMIT_ENDPOINT_CLASSES.includes(decision.endpointClass))
    throw new Error('Rate-limit decision endpoint class is invalid');
  if (
    !Number.isSafeInteger(decision.windowSeconds) ||
    decision.windowSeconds <= 0 ||
    decision.windowSeconds > MAX_WINDOW_SECONDS
  )
    throw new Error(
      'Rate-limit decision window must be a positive integer with a safe millisecond projection',
    );
  if (decision.dimensions.length === 0)
    throw new Error('Rate-limit decision requires at least one dimension');
  const keys = new Set<string>();
  for (const dimension of decision.dimensions) {
    if (
      dimension.identifier.length === 0 ||
      dimension.identifier.trim() !== dimension.identifier
    )
      throw new Error('Rate-limit decision identifier must be normalized');
    if (!Number.isSafeInteger(dimension.limit) || dimension.limit <= 0)
      throw new Error(
        'Rate-limit decision limit must be a positive safe integer',
      );
    const key = `${dimension.kind}\0${dimension.identifier}`;
    if (keys.has(key))
      throw new Error('Rate-limit decision dimensions must be unique');
    keys.add(key);
  }
}

function parseScriptResult(value: unknown): readonly number[] {
  if (
    !Array.isArray(value) ||
    (value.length !== 3 && value.length !== 6) ||
    !value.every((item) => typeof item === 'number' && Number.isInteger(item))
  ) {
    throw new Error('Invalid rate-limit script result');
  }
  return value as number[];
}

export class DistributedRateLimiter {
  constructor(private readonly executor: RateLimitScriptExecutor) {}

  async consume(
    decision: RateLimitDecision,
  ): Promise<DistributedRateLimitResult> {
    assertDecision(decision);
    const keys = decision.dimensions.map((_, index) =>
      counterKey(decision, index),
    );
    const [
      allowed = -1,
      retryMilliseconds = -1,
      limitedIndex = 0,
      remaining,
      limit,
      resetMilliseconds,
    ] = parseScriptResult(
      await this.executor.eval(
        CONSUME_SCRIPT,
        keys.length,
        ...keys,
        String(decision.windowSeconds * 1_000),
        ...decision.dimensions.map(({ limit: budget }) => String(budget)),
      ),
    );
    if (
      allowed === 1 &&
      retryMilliseconds === 0 &&
      limitedIndex === 0 &&
      remaining !== undefined &&
      limit !== undefined &&
      resetMilliseconds !== undefined
    ) {
      return {
        allowed: true,
        quota: {
          limit,
          remaining: Math.max(0, remaining),
          resetSeconds: Math.max(1, Math.ceil(resetMilliseconds / 1_000)),
        },
      };
    }
    const limitedDimension = decision.dimensions[limitedIndex - 1];
    if (
      allowed !== 0 ||
      retryMilliseconds < 0 ||
      limitedDimension === undefined
    ) {
      throw new Error('Invalid rate-limit script result');
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.min(
        60,
        Math.max(1, Math.ceil(retryMilliseconds / 1_000)),
      ),
      limitedDimension: limitedDimension.kind,
    };
  }
}
