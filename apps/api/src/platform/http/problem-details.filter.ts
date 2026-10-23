import { randomUUID } from 'node:crypto';
import {
  normalizeConcurrencyConflict,
  projectConcurrencyConflict,
  type ConcurrencyConflict,
} from './problems/concurrency-conflict.js';

import type { ApiProblem, ApiProblemIssue } from '@pertexo/contracts';
import {
  strongEtagSchema,
  workflowRecoveryUnavailableProblemSchema,
  workflowRecoveryRefusalSchema,
  workflowRevisionConflictProblemSchema,
  workflowLifecycleConflictProblemSchema,
  workflowNameConflictProblemSchema,
  type WorkflowLifecycleConflictProblem,
  type WorkflowNameConflictProblem,
  type WorkflowRevisionConflictProblem,
} from '@pertexo/contracts';
import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';

import {
  APPLICATION_ERROR_CATALOG,
  type ApplicationError,
  type ApplicationErrorCatalogEntry,
  type ApplicationErrorCode,
  isApplicationError,
} from './application-error.js';
import {
  createRequestContext,
  type HttpRequestLike,
  type HttpResponseLike,
  type RequestContext,
  RequestContextStore,
  setResponseHeader,
} from './request-context.js';
import { isRequestBodyError } from './request-body.js';
import { firstRequestHeader } from './request-headers.js';
import { normalizeWorkflowMetadataConflict } from './problems/workflow-metadata-conflict.js';
import {
  normalizeAutoPauseConflict,
  projectAutoPauseConflict,
  type AutoPauseConflictProblem,
  type AutoPauseConflictRevision,
} from './problems/auto-pause-conflict.js';

export const HTTP_ERROR_LOGGER = Symbol('HTTP_ERROR_LOGGER');
export const HTTP_APPLICATION_ERROR_MAPPERS = Symbol(
  'HTTP_APPLICATION_ERROR_MAPPERS',
);

type ProblemIssue = ApiProblemIssue;
type ProblemDetails =
  | ApiProblem
  | WorkflowRevisionConflictProblem
  | WorkflowLifecycleConflictProblem
  | WorkflowNameConflictProblem
  | AutoPauseConflictProblem
  | ReturnType<typeof projectConcurrencyConflict>;

export type HttpErrorLogEntry = Readonly<{
  code: ApplicationErrorCode;
  requestId: string;
  severity: ApplicationErrorCatalogEntry['severity'];
  actorId?: string;
  workspaceId?: string;
  instance?: string;
  cause: unknown;
}>;

export interface HttpErrorLogger {
  log(entry: HttpErrorLogEntry): void | Promise<void>;
}

export type HttpApplicationErrorMapper = (
  error: unknown,
  request: HttpRequestLike,
) => ApplicationError | undefined;

type ProblemResponse = HttpResponseLike & {
  code?: (status: number) => unknown;
  status?: (status: number) => unknown;
  send?: (body: ProblemDetails) => unknown;
  json?: (body: ProblemDetails) => unknown;
};

type NormalizedProblem = Readonly<{
  code: ApplicationErrorCode;
  status: number;
  title: string;
  detail?: string;
  errors?: readonly ProblemIssue[];
  revisionConflict?: Readonly<{
    currentRevision: number;
    currentEtag: string;
  }>;
  retryAfterSeconds?: number;
  currentLifecycleRevision?: number;
  currentNameRevision?: number;
  autoPauseConflict?: AutoPauseConflictRevision;
  concurrencyConflict?: ConcurrencyConflict;
  recoveryReason?: ReturnType<
    typeof workflowRecoveryRefusalSchema.parse
  >['reason'];
  cause?: unknown;
}>;

function text(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replaceAll('\r', '').replaceAll('\n', '').trim();
  return normalized.length === 0
    ? undefined
    : normalized.slice(0, maximumLength);
}

function pointer(path: readonly PropertyKey[]): string {
  return path
    .reduce<string>(
      (current, segment) =>
        `${current}/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`,
      '',
    )
    .slice(0, 1_024);
}

function zodIssues(error: ZodError): readonly ProblemIssue[] {
  return Object.freeze(
    error.issues.slice(0, 100).map((issue) => ({
      path: pointer(issue.path),
      code: issue.code,
      message: text(issue.message, 500) ?? 'Invalid value',
    })),
  );
}

function responseMessage(response: unknown): unknown {
  if (
    typeof response !== 'object' ||
    response === null ||
    !('message' in response)
  ) {
    return undefined;
  }
  return response.message;
}

function nestIssues(
  exception: HttpException,
): readonly ProblemIssue[] | undefined {
  const message = responseMessage(exception.getResponse());
  if (!Array.isArray(message)) {
    return undefined;
  }

  const issues = message
    .slice(0, 100)
    .map((item): ProblemIssue | undefined => {
      const safeMessage = text(item, 500);
      return safeMessage === undefined
        ? undefined
        : { path: '', code: 'validation', message: safeMessage };
    })
    .filter((issue): issue is ProblemIssue => issue !== undefined);

  return issues.length === 0 ? undefined : Object.freeze(issues);
}

function nestCode(status: number): ApplicationErrorCode {
  if (status === 400) return 'request.invalid';
  if (status === 401) return 'auth.unauthenticated';
  if (status === 403) return 'auth.forbidden';
  if (status === 404) return 'resource.not_found';
  return 'internal.unexpected';
}

function safeHttpStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : APPLICATION_ERROR_CATALOG['internal.unexpected'].status;
}

function unexpectedProblem(cause: unknown): NormalizedProblem {
  const fallback = APPLICATION_ERROR_CATALOG['internal.unexpected'];
  return {
    code: 'internal.unexpected',
    status: fallback.status,
    title: fallback.title,
    cause,
  };
}

function fromApplicationError(error: ApplicationError): NormalizedProblem {
  const entry = APPLICATION_ERROR_CATALOG[error.code];
  const detail =
    entry.exposeDetail && error.safeDetail !== undefined
      ? text(error.safeDetail, 2_000)
      : undefined;
  const issues = applicationProblemIssues(error);
  const base = {
    code: error.code,
    status: entry.status,
    title: entry.title,
    ...(detail === undefined ? {} : { detail }),
    cause: error.cause,
    ...(issues === undefined ? {} : { errors: issues }),
  };
  const retryableProblem =
    error.code === 'request.rate_limited' ||
    error.code === 'request.rate_limit_unavailable' ||
    error.code === 'workspace.quota_exceeded' ||
    error.code === 'workflow.validation_unavailable';
  if (retryableProblem) {
    const retryAfterSeconds = error.details?.retryAfterSeconds;
    return typeof retryAfterSeconds === 'number' &&
      Number.isSafeInteger(retryAfterSeconds) &&
      retryAfterSeconds >= 1 &&
      retryAfterSeconds <= 300
      ? { ...base, retryAfterSeconds }
      : base;
  }
  if (error.code === 'run.recovery_unavailable') {
    const refusal = workflowRecoveryRefusalSchema.safeParse({
      kind: 'refused',
      reason: error.details?.reason,
    });
    return refusal.success
      ? { ...base, recoveryReason: refusal.data.reason }
      : unexpectedProblem(error);
  }
  const autoPauseConflict = normalizeAutoPauseConflict(error);
  if (autoPauseConflict !== undefined) return { ...base, autoPauseConflict };
  const concurrencyConflict = normalizeConcurrencyConflict(error);
  if (concurrencyConflict !== undefined)
    return { ...base, concurrencyConflict };
  const metadataConflict = normalizeWorkflowMetadataConflict(error);
  if (metadataConflict === 'invalid') return unexpectedProblem(error);
  if (metadataConflict !== undefined) return { ...base, ...metadataConflict };
  if (error.code !== 'workflow.revision_conflict') return base;
  const currentRevision = error.details?.currentRevision;
  const currentEtag = error.details?.currentEtag;
  const parsedEtag = strongEtagSchema.safeParse(currentEtag);
  const invalidRevisionConflict =
    typeof currentRevision !== 'number' ||
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < 1 ||
    !parsedEtag.success;
  if (invalidRevisionConflict) return unexpectedProblem(error);
  return {
    ...base,
    revisionConflict: { currentRevision, currentEtag: parsedEtag.data },
  };
}

function safeApplicationIssues(
  value: unknown,
): readonly ProblemIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues = value
    .slice(0, 100)
    .map((issue: unknown): ProblemIssue | undefined => {
      if (typeof issue !== 'object' || issue === null) return undefined;
      const path = 'path' in issue ? text(issue.path, 1_024) : undefined;
      const code = 'code' in issue ? text(issue.code, 128) : undefined;
      const message = 'message' in issue ? text(issue.message, 500) : undefined;
      return path === undefined || code === undefined || message === undefined
        ? undefined
        : { path, code, message };
    })
    .filter((issue): issue is ProblemIssue => issue !== undefined);
  return issues.length === 0 ? undefined : Object.freeze(issues);
}

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
    request.raw?.destroyed === true || request.raw?.socket?.destroyed === true;
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

function applicationProblemIssues(
  error: ApplicationError,
): readonly ProblemIssue[] | undefined {
  if (error.code === 'workflow.invalid' || error.code === 'form.invalid')
    return safeApplicationIssues(error.details?.issues);
  if (error.code === 'request.invalid' && isRequestBodyError(error.cause))
    return zodIssues(error.cause);
  return undefined;
}
