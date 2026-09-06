import { z } from 'zod';

import {
  applicationError,
  isApplicationError,
  throwApplicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import { AuthorizationError } from '../workspaces/index.js';
import { WorkflowRunNotFoundError } from './use-cases.js';

export class WorkflowRunNotExecutableError extends Error {
  public override readonly name = 'WorkflowRunNotExecutableError';
}

export class WorkflowRunNotCancelableError extends Error {
  public override readonly name = 'WorkflowRunNotCancelableError';
}

export class WorkflowRunIdempotencyConflictError extends Error {
  public override readonly name = 'WorkflowRunIdempotencyConflictError';
}

export function mapWorkflowRunError(error: unknown): ApplicationError {
  if (isApplicationError(error)) return error;
  if (error instanceof AuthorizationError)
    return applicationError(error.code, { safeDetail: error.message });
  if (error instanceof WorkflowRunNotFoundError)
    return applicationError('resource.not_found');
  if (error instanceof WorkflowRunNotExecutableError)
    return applicationError('workflow.not_published', {
      safeDetail: 'The workflow has no compatible executable publication.',
    });
  if (error instanceof WorkflowRunNotCancelableError)
    return applicationError('run.not_cancelable', {
      safeDetail: 'The workflow run is already terminal.',
    });
  if (error instanceof WorkflowRunIdempotencyConflictError)
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  if (error instanceof z.ZodError || error instanceof TypeError)
    return applicationError('request.invalid', {
      safeDetail: 'The workflow run request is invalid.',
    });
  return applicationError('internal.unexpected', { cause: error });
}

export function throwWorkflowRunError(error: unknown): never {
  return throwApplicationError(mapWorkflowRunError(error));
}
