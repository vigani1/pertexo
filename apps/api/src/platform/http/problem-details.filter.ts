import { randomUUID } from 'node:crypto';
import { projectConcurrencyConflict } from './problems/concurrency-conflict.js';
import type { ApiProblem } from '@pertexo/contracts';
import {
  workflowRecoveryUnavailableProblemSchema,
  workflowRevisionConflictProblemSchema,
  workflowLifecycleConflictProblemSchema,
  workflowNameConflictProblemSchema,
} from '@pertexo/contracts';
import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';
import {
  APPLICATION_ERROR_CATALOG,
  isApplicationError,
} from './application-error.js';
import {
  createRequestContext,
  type HttpRequestLike,
  type RequestContext,
  RequestContextStore,
  setResponseHeader,
} from './request-context.js';

import { firstRequestHeader } from './request-headers.js';

import { projectAutoPauseConflict } from './problems/auto-pause-conflict.js';
import type {
  ProblemDetails,
  HttpErrorLogger,
  HttpApplicationErrorMapper,
  ProblemResponse,
  NormalizedProblem,
} from './problems/normalization/contract.js';
import {
  text,
  zodIssues,
  nestIssues,
  nestCode,
  safeHttpStatus,
} from './problems/normalization/values.js';
import { fromApplicationError } from './problems/normalization/application.js';

export {
  type HttpErrorLogEntry,
  type HttpErrorLogger,
  type HttpApplicationErrorMapper,
} from './problems/normalization/contract.js';
export const HTTP_ERROR_LOGGER = Symbol('HTTP_ERROR_LOGGER');

export const HTTP_APPLICATION_ERROR_MAPPERS = Symbol(
  'HTTP_APPLICATION_ERROR_MAPPERS',
);

function normalize(
  exception: unknown,
  request: HttpRequestLike,
  applicationErrorMappers: readonly HttpApplicationErrorMapper[],
): NormalizedProblem {
  if (!(exception instanceof Error) && isApplicationError(exception)) {
    return fromApplicationError(exception);
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = nestCode(status);
    const entry = APPLICATION_ERROR_CATALOG[code];
    const issues = nestIssues(exception);
    return {
      code,
      status:
        code === 'internal.unexpected' ? safeHttpStatus(status) : entry.status,
      title: entry.title,
      ...(issues === undefined ? {} : { errors: issues }),
    };
  }

  for (const mapper of applicationErrorMappers) {
    const mapped = mapper(exception, request);
    if (mapped !== undefined) return fromApplicationError(mapped);
  }

  if (exception instanceof ZodError) {
    const entry = APPLICATION_ERROR_CATALOG['request.invalid'];
    return {
      code: 'request.invalid',
      status: entry.status,
      title: entry.title,
      errors: zodIssues(exception),
    };
  }

  if (isApplicationError(exception)) return fromApplicationError(exception);
  const entry = APPLICATION_ERROR_CATALOG['internal.unexpected'];
  return {
    code: 'internal.unexpected',
    status: entry.status,
    title: entry.title,
    cause: exception,
  };
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError';
}

/**
 * The browser closed the request (navigated, closed the tab) and the work it
 * started stopped with it: an expected end, not a server failure. Area error
 * mappers wrap what they don't recognise as an unexpected application error,
 * so the abort can arrive as that error's cause.
 */
function abandonedByClient(
  exception: unknown,
  request: HttpRequestLike,
): boolean {
  const gone =
    (request.raw?.destroyed ?? false) ||
    (request.raw?.socket?.destroyed ?? false);
  if (!gone) return false;
  if (isAbortError(exception)) return true;
  const cause =
    exception instanceof Error || isApplicationError(exception)
      ? exception.cause
      : undefined;
  return isAbortError(cause);
}

function normalizeFailClosed(
  exception: unknown,
  request: HttpRequestLike,
  applicationErrorMappers: readonly HttpApplicationErrorMapper[],
): NormalizedProblem {
  if (abandonedByClient(exception, request)) {
    const entry = APPLICATION_ERROR_CATALOG['request.aborted'];
    return {
      code: 'request.aborted',
      status: entry.status,
      title: entry.title,
      cause: exception,
    };
  }
  try {
    return normalize(exception, request, applicationErrorMappers);
  } catch {
    const entry = APPLICATION_ERROR_CATALOG['internal.unexpected'];
    return {
      code: 'internal.unexpected',
      status: entry.status,
      title: entry.title,
      cause: exception,
    };
  }
}

function instanceFrom(request: HttpRequestLike): string | undefined {
  const url = text(request.url, 2_048);
  if (url === undefined) {
    return undefined;
  }

  const withoutQuery = url.replace(/[?#].*$/u, '');
  if (withoutQuery.startsWith('/')) {
    return withoutQuery;
  }

  try {
    return new URL(withoutQuery).pathname;
  } catch {
    return undefined;
  }
}

function contextFor(
  contexts: RequestContextStore,
  request: HttpRequestLike,
): RequestContext {
  try {
    return contexts.get();
  } catch {
    return createRequestContext(
      firstRequestHeader(request.headers, 'x-request-id') ?? randomUUID(),
    );
  }
}

function writeProblem(
  response: ProblemResponse,
  status: number,
  problem: ProblemDetails,
): void {
  setResponseHeader(response, 'content-type', 'application/problem+json');
  if (typeof response.code === 'function') {
    response.code(status);
  } else {
    response.status?.(status);
  }

  if (typeof response.send === 'function') {
    response.send(problem);
  } else {
    response.json?.(problem);
  }
}

function problemDetails(
  normalized: NormalizedProblem,
  baseProblem: ApiProblem,
): ProblemDetails {
  if (normalized.recoveryReason !== undefined)
    return workflowRecoveryUnavailableProblemSchema.parse({
      ...baseProblem,
      reason: normalized.recoveryReason,
    });
  if (normalized.concurrencyConflict !== undefined)
    return projectConcurrencyConflict(
      baseProblem,
      normalized.concurrencyConflict,
    );
  if (normalized.autoPauseConflict !== undefined)
    return projectAutoPauseConflict(baseProblem, normalized.autoPauseConflict);
  if (normalized.currentLifecycleRevision !== undefined)
    return workflowLifecycleConflictProblemSchema.parse({
      ...baseProblem,
      currentLifecycleRevision: normalized.currentLifecycleRevision,
    });
  if (normalized.currentNameRevision !== undefined)
    return workflowNameConflictProblemSchema.parse({
      ...baseProblem,
      currentNameRevision: normalized.currentNameRevision,
    });
  if (normalized.revisionConflict !== undefined)
    return workflowRevisionConflictProblemSchema.parse({
      ...baseProblem,
      ...normalized.revisionConflict,
    });
  return Object.freeze(baseProblem);
}

// The emitted decorator helper contains a compiler-generated fallback that
// application code cannot invoke; exclude that synthetic branch from V8 data.
/* v8 ignore next */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  public constructor(
    private readonly contexts: RequestContextStore,
    private readonly logger?: HttpErrorLogger,
    private readonly applicationErrorMappers: readonly HttpApplicationErrorMapper[] = [],
  ) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<ProblemResponse>();
    const normalized = normalizeFailClosed(
      exception,
      request,
      this.applicationErrorMappers,
    );
    const context = contextFor(this.contexts, request);
    const requestId = context.requestId;
    const instance = instanceFrom(request);
    const baseProblem: ApiProblem = {
      type: APPLICATION_ERROR_CATALOG[normalized.code].type,
      title: normalized.title,
      status: normalized.status,
      ...(normalized.detail === undefined ? {} : { detail: normalized.detail }),
      ...(instance === undefined ? {} : { instance }),
      code: normalized.code,
      requestId,
      ...(normalized.errors === undefined ? {} : { errors: normalized.errors }),
    };
    const problem = problemDetails(normalized, baseProblem);

    if (normalized.revisionConflict !== undefined) {
      setResponseHeader(
        response,
        'etag',
        normalized.revisionConflict.currentEtag,
      );
    }
    if (normalized.retryAfterSeconds !== undefined) {
      setResponseHeader(
        response,
        'retry-after',
        String(normalized.retryAfterSeconds),
      );
    }

    if (this.logger !== undefined) {
      try {
        const logged = this.logger.log({
          code: normalized.code,
          requestId,
          severity: APPLICATION_ERROR_CATALOG[normalized.code].severity,
          ...(context.actor === undefined
            ? {}
            : { actorId: context.actor.actorId }),
          ...(context.workspaceId === undefined
            ? {}
            : { workspaceId: context.workspaceId }),
          ...(instance === undefined ? {} : { instance }),
          cause: normalized.cause,
        });
        void Promise.resolve(logged).catch(() => undefined);
      } catch {
        // Diagnostic sinks must not alter the problem response contract.
      }
    }

    writeProblem(response, normalized.status, problem);
  }
}
