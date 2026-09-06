import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import {
  AbuseRateLimitPolicy,
  type DistributedRateLimitResult,
  type RateLimitEndpointClass,
  type RateLimitFailureMode,
  type RateLimitDimensionKind,
  type RateLimitSubject,
} from '@pertexo/rate-limit';

import { RATE_LIMIT_EXEMPT, RATE_LIMIT_METADATA } from './metadata.js';
import {
  applicationError,
  throwApplicationError,
} from '../http/application-error.js';
import { firstRequestHeader } from '../http/request-headers.js';

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

type RateLimitRequest = Readonly<{
  ip?: string;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  params?: unknown;
  identitySession?: Readonly<{ userId?: string }>;
  authorizedWorkspace?: unknown;
}>;

function origin(request: RateLimitRequest): string {
  const raw =
    firstRequestHeader(request.headers, 'origin') ??
    firstRequestHeader(request.headers, 'referer');
  if (raw === undefined) return 'unknown-origin';
  try {
    return new URL(raw).origin;
  } catch {
    return 'invalid-origin';
  }
}

function objectString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }
  const field = (value as Readonly<Record<string, unknown>>)[key];
  return typeof field === 'string' ? field : undefined;
}

function subject(request: RateLimitRequest): RateLimitSubject {
  const workspaceId =
    objectString(request.authorizedWorkspace, 'workspaceId') ??
    objectString(request.params, 'workspaceId');
  const connectionId = objectString(request.params, 'connectionId');
  const actorId = request.identitySession?.userId;
  return {
    ...(request.ip === undefined ? {} : { clientAddress: request.ip }),
    origin: origin(request),
    ...(actorId === undefined ? {} : { actorId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(connectionId === undefined ? {} : { connectionId }),
  };
}

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  public constructor(
    private readonly reflector: Reflector,
    private readonly consumer: RateLimitConsumer,
    private readonly metrics: RateLimitMetricRecorder,
    private readonly policy = new AbuseRateLimitPolicy(),
  ) {}

  public async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const metadata = this.reflector.getAllAndOverride<
      RateLimitEndpointClass | typeof RATE_LIMIT_EXEMPT | undefined
    >(RATE_LIMIT_METADATA, [context.getHandler(), context.getClass()]);
    if (metadata === RATE_LIMIT_EXEMPT) return next.handle();
    if (metadata === undefined) {
      throw new Error('HTTP route is missing rate-limit classification');
    }
    const decision = this.policy.evaluate(
      metadata,
      subject(context.switchToHttp().getRequest<RateLimitRequest>()),
    );
    let result: DistributedRateLimitResult;
    try {
      result = await this.consumer.consume(decision);
    } catch {
      this.metrics.record({
        endpointClass: metadata,
        failureMode: decision.failureMode,
        outcome: 'backend_error',
      });
      if (decision.failureMode === 'open') return next.handle();
      return throwApplicationError(
        applicationError('request.rate_limit_unavailable', {
          details: { retryAfterSeconds: 1 },
        }),
      );
    }
    if (!result.allowed) {
      this.metrics.record({
        endpointClass: metadata,
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
    this.metrics.record({
      endpointClass: metadata,
      failureMode: decision.failureMode,
      outcome: 'allowed',
    });
    return next.handle();
  }
}
