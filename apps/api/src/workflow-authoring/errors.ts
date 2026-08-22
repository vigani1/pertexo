import {
  WorkflowCreateIdempotencyConflictError,
  WorkflowDefinitionPlacementError,
  WorkflowNotFoundError,
  WorkflowPublishIdempotencyConflictError,
  WorkflowRevisionConflictError,
} from '@pertexo/database';
import { z } from 'zod';

import {
  applicationError,
  isApplicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import { AuthorizationError } from '../workspaces/index.js';
import {
  InvalidWorkflowHeaderError,
  PreconditionRequiredError,
} from './preconditions.js';
import { InvalidWorkflowCursorError } from './use-cases.js';
import {
  InvalidWorkflowGraphError,
  WorkflowGraphContractError,
} from './graph.js';

export class WorkflowVersionListingUnavailableError extends Error {
  public override readonly name = 'WorkflowVersionListingUnavailableError';
  public constructor() {
    super('workflow version listing persistence capability is unavailable');
  }
}

export function mapWorkflowAuthoringError(error: unknown): ApplicationError {
  if (isApplicationError(error)) return error;
  if (error instanceof PreconditionRequiredError)
    return applicationError('request.precondition_required', {
      safeDetail: 'If-Match is required for this operation.',
    });
  if (error instanceof InvalidWorkflowHeaderError)
    return applicationError('request.invalid', {
      safeDetail: error.message,
    });
  if (error instanceof InvalidWorkflowCursorError)
    return applicationError('request.invalid', {
      safeDetail: 'The workflow cursor is invalid.',
    });
  if (error instanceof AuthorizationError)
    return applicationError(error.code, {
      safeDetail: error.message,
    });
  if (error instanceof WorkflowNotFoundError)
    return applicationError('resource.not_found');
  if (
    error instanceof WorkflowCreateIdempotencyConflictError ||
    error instanceof WorkflowPublishIdempotencyConflictError
  )
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  if (error instanceof WorkflowRevisionConflictError)
    return applicationError('workflow.revision_conflict', {
      safeDetail: 'The workflow draft has changed; reload it before retrying.',
      details: {
        currentRevision: error.currentRevision,
        currentEtag: error.currentEtag,
      },
    });
  if (error instanceof WorkflowDefinitionPlacementError)
    return applicationError('workflow.invalid', {
      safeDetail:
        'The workflow contains a definition that can no longer be added.',
      details: { issues: error.issues },
    });
  if (error instanceof InvalidWorkflowGraphError)
    return applicationError('workflow.invalid', {
      safeDetail: 'The workflow cannot be published in its current form.',
      details: { issues: error.issues },
    });
  if (
    error instanceof WorkflowGraphContractError ||
    error instanceof z.ZodError
  )
    return applicationError('request.invalid', {
      safeDetail: 'The workflow graph is invalid.',
    });
  if (error instanceof WorkflowVersionListingUnavailableError)
    return applicationError('internal.unexpected', {
      safeDetail: 'Workflow version listing is not wired in this runtime.',
      cause: error,
    });
  return applicationError('internal.unexpected', { cause: error });
}

export function throwWorkflowApplicationError(error: unknown): never {
  // The shared problem filter consumes frozen application errors.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw mapWorkflowAuthoringError(error);
}
