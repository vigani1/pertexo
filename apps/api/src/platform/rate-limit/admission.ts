import { AbuseRateLimitPolicy, LocalRateLimiter } from '@pertexo/rate-limit';
import type {
  DistributedRateLimitResult,
  RateLimitQuota,
  RateLimitEndpointClass,
  RateLimitFailureMode,
  RateLimitDimensionKind,
  RateLimitSubject,
} from '@pertexo/rate-limit';
import {
  applicationError,
  throwApplicationError,
} from '../http/application-error.js';

export type RateLimitConsumer = Readonly<{
  consume(
    decision: ReturnType<AbuseRateLimitPolicy['evaluate']>,
  ): Promise<DistributedRateLimitResult>;
}>;

export type RateLimitMetricRecorder = Readonly<{
  record(event: {
    endpointClass: RateLimitEndpointClass;
    failureMode: RateLimitFailureMode;
    outcome: 'allowed' | 'limited' | 'backend_error';
    limitedDimension?: RateLimitDimensionKind;
  }): void;
}>;

function recordMetric(
  recorder: RateLimitMetricRecorder,
  event: Parameters<RateLimitMetricRecorder['record']>[0],
): void {
  try {
    recorder.record(event);
  } catch {
    // Diagnostic recording cannot change request-admission authority.
  }
}

/** One per process, so what's counted during an outage is shared by every route. */
const duringRedisOutage = new LocalRateLimiter();

export type RateLimitOutcome =
  | Readonly<{ kind: 'admitted'; quota?: RateLimitQuota }>
  | Readonly<{ kind: 'limited'; retryAfterSeconds: number }>;

/**
 * The one admission decision: records the metric and honours the policy's
 * failure mode. A closed policy keeps its limit in this process while Redis is out,
 * so an outage neither stops sign-in and run starts nor lifts the limit. Each
 * transport turns the outcome into its own problem shape.
 */
export async function admitRateLimit(
  consumer: RateLimitConsumer,
  metrics: RateLimitMetricRecorder,
  decision: ReturnType<AbuseRateLimitPolicy['evaluate']>,
): Promise<RateLimitOutcome> {
  const { endpointClass, failureMode } = decision;
  let result: DistributedRateLimitResult;
  try {
    result = await consumer.consume(decision);
  } catch {
    recordMetric(metrics, {
      endpointClass,
      failureMode,
      outcome: 'backend_error',
    });
    if (failureMode === 'open') return { kind: 'admitted' };
    result = duringRedisOutage.consume(decision);
  }
  if (!result.allowed) {
    recordMetric(metrics, {
      endpointClass,
      failureMode,
      outcome: 'limited',
      limitedDimension: result.limitedDimension,
    });
    return { kind: 'limited', retryAfterSeconds: result.retryAfterSeconds };
  }
  recordMetric(metrics, { endpointClass, failureMode, outcome: 'allowed' });
  return result.quota === undefined
    ? { kind: 'admitted' }
    : { kind: 'admitted', quota: result.quota };
}

export class HttpRateLimitAdmission {
  public constructor(
    private readonly consumer: RateLimitConsumer,
    private readonly metrics: RateLimitMetricRecorder,
    private readonly policy = new AbuseRateLimitPolicy(),
  ) {}
  public async admit(
    endpointClass: RateLimitEndpointClass,
    subject: RateLimitSubject,
  ): Promise<RateLimitQuota | undefined> {
    const outcome = await admitRateLimit(
      this.consumer,
      this.metrics,
      this.policy.evaluate(endpointClass, subject),
    );
    if (outcome.kind === 'limited')
      throwApplicationError(
        applicationError('request.rate_limited', {
          details: { retryAfterSeconds: outcome.retryAfterSeconds },
        }),
      );
    return outcome.kind === 'admitted' ? outcome.quota : undefined;
  }
}
