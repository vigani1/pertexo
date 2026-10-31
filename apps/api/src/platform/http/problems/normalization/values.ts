import type { HttpException } from '@nestjs/common';

import type { ZodError } from 'zod';
import {
  APPLICATION_ERROR_CATALOG,
  type ApplicationError,
  type ApplicationErrorCode,
} from '../../application-error.js';

import { isRequestBodyError } from '../../request-body.js';

import type { ProblemIssue, NormalizedProblem } from './contract.js';

export function text(
  value: unknown,
  maximumLength: number,
): string | undefined {
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

export function zodIssues(error: ZodError): readonly ProblemIssue[] {
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

export function nestIssues(
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

export function nestCode(status: number): ApplicationErrorCode {
  if (status === 400) return 'request.invalid';
  if (status === 401) return 'auth.unauthenticated';
  if (status === 403) return 'auth.forbidden';
  if (status === 404) return 'resource.not_found';
  return 'internal.unexpected';
}

export function safeHttpStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : APPLICATION_ERROR_CATALOG['internal.unexpected'].status;
}

export function unexpectedProblem(cause: unknown): NormalizedProblem {
  const fallback = APPLICATION_ERROR_CATALOG['internal.unexpected'];
  return {
    code: 'internal.unexpected',
    status: fallback.status,
    title: fallback.title,
    cause,
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

export function applicationProblemIssues(
  error: ApplicationError,
): readonly ProblemIssue[] | undefined {
  if (error.code === 'connection.oauth2_endpoint_refused')
    return safeApplicationIssues(error.details?.issues);
  if (error.code === 'workflow.invalid' || error.code === 'form.invalid')
    return safeApplicationIssues(error.details?.issues);
  if (error.code === 'request.invalid' && isRequestBodyError(error.cause))
    return zodIssues(error.cause);
  return undefined;
}
