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
    const decision = this.policy.evaluate(endpointClass, subject);
    let result: DistributedRateLimitResult;
    try {
      result = await this.consumer.consume(decision);
    } catch {
      recordMetric(this.metrics, {
        endpointClass,
        failureMode: decision.failureMode,
        outcome: 'backend_error',
      });
      if (decision.failureMode === 'open') return;
      return throwApplicationError(
        applicationError('request.rate_limit_unavailable', {
          details: { retryAfterSeconds: 1 },
        }),
      );
    }
    if (!result.allowed) {
      recordMetric(this.metrics, {
        endpointClass,
        failureMode: decision.failureMode,
        outcome: 'limited',
        limitedDimension: result.limitedDimension,
      });
      return throwApplicationError(
        applicationError('request.rate_limited', {
          details: { retryAfterSeconds: result.retryAfterSeconds },
        }),
      );
    }
    recordMetric(this.metrics, {
      endpointClass,
      failureMode: decision.failureMode,
      outcome: 'allowed',
    });
  }
}
