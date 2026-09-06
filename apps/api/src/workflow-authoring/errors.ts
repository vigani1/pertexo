import {
  WorkflowIdempotencyConflictError,
  WorkflowDefinitionPlacementError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  WorkflowLifecycleRevisionConflictError,
} from '@pertexo/database/api';
import { z } from 'zod';

import {
  applicationError,
  isApplicationError,
  throwApplicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import { AuthorizationError } from '../workspaces/index.js';
import { WorkflowHeaderError } from './preconditions.js';
import { InvalidWorkflowCursorError } from './use-cases.js';
import {
  InvalidWorkflowGraphError,
  WorkflowGraphContractError,
} from './graph.js';

export function mapWorkflowAuthoringError(error: unknown): ApplicationError {
  if (isApplicationError(error)) return error;
  if (
    error instanceof WorkflowHeaderError &&
    error.code === 'precondition_required'
  )
    return applicationError('request.precondition_required', {
      safeDetail: 'If-Match is required for this operation.',
    });
  if (error instanceof WorkflowHeaderError)
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
  if (error instanceof WorkflowIdempotencyConflictError)
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
  if (error instanceof WorkflowLifecycleRevisionConflictError)
    return applicationError('workflow.lifecycle_conflict', {
      safeDetail:
        'The workflow lifecycle has changed; reload it before retrying.',
      details: { currentLifecycleRevision: error.currentRevision },
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
  return applicationError('internal.unexpected', { cause: error });
}

export function throwWorkflowApplicationError(error: unknown): never {
  return throwApplicationError(mapWorkflowAuthoringError(error));
}
