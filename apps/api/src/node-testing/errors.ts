import {
  PriorPreviewInputUnavailableError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/database/api';
import {
  InvalidWorkflowGraphError,
  WorkflowGraphContractError,
} from '@pertexo/workflow-model/graph';
import { z } from 'zod';

import { AuthorizationError } from '../workspaces/index.js';
import {
  applicationError,
  InvalidIdempotencyKeyError,
  isApplicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import type { NodeValidationIssue } from './validation.js';

export class NodeTestRequestError extends Error {
  public override readonly name = 'NodeTestRequestError';
  public constructor(
    public readonly code: 'idempotency_conflict' | 'idempotency_required',
  ) {
    super(
      code === 'idempotency_required'
        ? 'Idempotency-Key is required for test_execute'
        : 'request.idempotency_conflict',
    );
  }
}

export class NodeTestInvalidError extends Error {
  public override readonly name = 'NodeTestInvalidError';
  public constructor(public readonly issues: readonly NodeValidationIssue[]) {
    super('Selected node is not valid for preview');
  }
}

export function mapNodeTestingError(error: unknown): ApplicationError {
  if (isApplicationError(error)) return error;
  if (
    error instanceof NodeTestRequestError &&
    error.code === 'idempotency_required'
  )
    return applicationError('request.precondition_required', {
      safeDetail: 'Idempotency-Key is required for test_execute.',
    });
  if (error instanceof InvalidIdempotencyKeyError)
    return applicationError('request.invalid', { safeDetail: error.message });
  if (error instanceof AuthorizationError)
    return applicationError(error.code, { safeDetail: error.message });
  if (error instanceof WorkflowNotFoundError)
    return applicationError('resource.not_found');
  if (error instanceof NodeTestRequestError)
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
  if (error instanceof NodeTestInvalidError)
    return applicationError('workflow.invalid', {
      safeDetail: 'The selected node is not valid for preview.',
      details: { issues: error.issues },
    });
  if (error instanceof PriorPreviewInputUnavailableError)
    return applicationError('workflow.invalid', {
      safeDetail: 'The selected prior preview output is unavailable.',
    });
  if (error instanceof InvalidWorkflowGraphError)
    return applicationError('workflow.invalid', {
      safeDetail: 'The workflow cannot be tested in its current form.',
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
