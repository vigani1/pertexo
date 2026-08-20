import { randomUUID } from 'node:crypto';

import type { ApiProblem, ApiProblemIssue } from '@pertexo/contracts/errors';
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

export const HTTP_ERROR_LOGGER = Symbol('HTTP_ERROR_LOGGER');

export type ProblemIssue = ApiProblemIssue;
export type ProblemDetails = ApiProblem;

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
  return status >= 400 && status <= 599
    ? status
    : APPLICATION_ERROR_CATALOG['internal.unexpected'].status;
}

function fromApplicationError(error: ApplicationError): NormalizedProblem {
  const entry = APPLICATION_ERROR_CATALOG[error.code];
  const detail =
    entry.exposeDetail && error.safeDetail !== undefined
      ? text(error.safeDetail, 2_000)
      : undefined;
  return {
    code: error.code,
    status: entry.status,
    title: entry.title,
    ...(detail === undefined ? {} : { detail }),
    cause: error.cause,
  };
}

function normalize(exception: unknown): NormalizedProblem {
  if (isApplicationError(exception)) {
    return fromApplicationError(exception);
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

  const entry = APPLICATION_ERROR_CATALOG['internal.unexpected'];
  return {
    code: 'internal.unexpected',
    status: entry.status,
    title: entry.title,
    cause: exception,
  };
}

function instanceFrom(request: HttpRequestLike): string | undefined {
  const url = text(request.url, 2_048);
  if (url === undefined) {
    return undefined;
  }

  const withoutQuery = url.split(/[?#]/u, 1)[0] ?? '';
  if (withoutQuery.startsWith('/')) {
    return withoutQuery;
  }

  try {
    return new URL(withoutQuery).pathname;
  } catch {
    return undefined;
  }
}

function requestHeader(
  request: HttpRequestLike,
  name: string,
): string | undefined {
  const headers = request.headers;
  if (headers === undefined) {
    return undefined;
  }

  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  const value = key === undefined ? undefined : headers[key];
  return typeof value === 'string' ? value : value?.[0];
}

function contextFor(
  contexts: RequestContextStore,
  request: HttpRequestLike,
): RequestContext {
  try {
    return contexts.get();
  } catch {
    return createRequestContext(
      requestHeader(request, 'x-request-id') ?? randomUUID(),
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

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  public constructor(
    private readonly contexts: RequestContextStore,
    private readonly logger?: HttpErrorLogger,
  ) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<ProblemResponse>();
    const normalized = normalize(exception);
    const context = contextFor(this.contexts, request);
    const requestId = context.requestId;
    const instance = instanceFrom(request);
    const problem: ProblemDetails = Object.freeze({
      type: `urn:pertexo:problem:${normalized.code}`,
      title: normalized.title,
      status: normalized.status,
      ...(normalized.detail === undefined ? {} : { detail: normalized.detail }),
      ...(instance === undefined ? {} : { instance }),
      code: normalized.code,
      requestId,
      ...(normalized.errors === undefined ? {} : { errors: normalized.errors }),
    });

    if (this.logger !== undefined) {
      void Promise.resolve(
        this.logger.log({
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
        }),
      ).catch(() => undefined);
    }

    writeProblem(response, normalized.status, problem);
  }
}
