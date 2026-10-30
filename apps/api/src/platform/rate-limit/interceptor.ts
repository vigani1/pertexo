import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import type {
  RateLimitEndpointClass,
  RateLimitSubject,
} from '@pertexo/rate-limit';
import { HttpRateLimitAdmission } from './admission.js';

import { RATE_LIMIT_EXEMPT, RATE_LIMIT_METADATA } from './metadata.js';
import { firstRequestHeader } from '../http/request-headers.js';

export type {
  RateLimitConsumer,
  RateLimitMetricRecorder,
} from './admission.js';
type RateLimitRequest = Readonly<{
  ip?: string;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  params?: unknown;
  identitySession?: Readonly<{ userId?: string }>;
  apiTokenActor?: Readonly<{ actorId: string; tokenId: string }>;
  authorizedWorkspace?: unknown;
}>;

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
  const formId = objectString(request.params, 'publicId');
  const actorId =
    request.apiTokenActor?.actorId ?? request.identitySession?.userId;
  return {
    ...(request.ip === undefined ? {} : { clientAddress: request.ip }),
    ...(formId === undefined ? {} : { formId }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(request.apiTokenActor === undefined
      ? {}
      : { tokenId: request.apiTokenActor.tokenId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(connectionId === undefined ? {} : { connectionId }),
  };
}

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  public constructor(
    private readonly reflector: Reflector,
    private readonly admission: HttpRateLimitAdmission,
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
    await this.admission.admit(
      metadata,
      subject(context.switchToHttp().getRequest<RateLimitRequest>()),
    );
    return next.handle();
  }
}
