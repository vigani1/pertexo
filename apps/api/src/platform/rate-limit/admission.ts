import { AbuseRateLimitPolicy } from '@pertexo/rate-limit';
import type {
  DistributedRateLimitResult,
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

export type RateLimitOutcome =
  | Readonly<{ kind: 'admitted' }>
  | Readonly<{ kind: 'limited'; retryAfterSeconds: number }>
  | Readonly<{ kind: 'unavailable'; cause: unknown }>;

/**
 * The one admission decision: records the metric and honours the policy's
 * failure mode. Each transport turns the outcome into its own problem shape.
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
  } catch (cause: unknown) {
    recordMetric(metrics, {
      endpointClass,
      failureMode,
      outcome: 'backend_error',
    });
    return failureMode === 'open'
      ? { kind: 'admitted' }
      : { kind: 'unavailable', cause };
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
  return { kind: 'admitted' };
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
  ): Promise<void> {
    const outcome = await admitRateLimit(
      this.consumer,
      this.metrics,
      this.policy.evaluate(endpointClass, subject),
    );
    if (outcome.kind === 'unavailable')
      throwApplicationError(
        applicationError('request.rate_limit_unavailable', {
          cause: outcome.cause,
          details: { retryAfterSeconds: 1 },
        }),
      );
    if (outcome.kind === 'limited')
      throwApplicationError(
        applicationError('request.rate_limited', {
          details: { retryAfterSeconds: outcome.retryAfterSeconds },
        }),
      );
  }
}
