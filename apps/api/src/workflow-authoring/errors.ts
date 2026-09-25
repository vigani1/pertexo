import {
  WorkflowIdempotencyConflictError,
  WorkflowDefinitionPlacementError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  WorkflowLifecycleRevisionConflictError,
  WorkflowNameRevisionConflictError,
} from '@pertexo/database/api';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { z } from 'zod';

import {
  applicationError,
  isApplicationError,
  throwApplicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import { AuthorizationError } from '../workspaces/index.js';
import { WorkflowHeaderError } from './preconditions.js';
import { InvalidWorkflowCursorError } from './cursor.js';
import {
  InvalidWorkflowGraphError,
  WorkflowGraphContractError,
} from './graph.js';

/**
 * Engine compile failures a person can cause and fix, in their words. Any
 * other failure keeps the engine's own sentence.
 */
const EXECUTABLE_PROBLEMS: Readonly<Record<string, string>> = {
  'workflow edge source port is not configured':
    'A Switch or Parallel step has a connection from a branch it doesn’t define. Add that branch in its setup, or remove the connection.',
  'Merge must reference a pinned Parallel node':
    'A Merge step doesn’t say which Parallel step it joins. Choose it in the Merge step’s setup.',
  'Parallel requires exactly one paired Merge':
    'Each Parallel step needs exactly one Merge step that joins its branches.',
  'Merge count policy exceeds paired Parallel branches':
    'A Merge step waits for more branches than its Parallel step has.',
  'each Parallel branch must reach its matching Merge input':
    'Every branch of a Parallel step has to lead to its Merge step.',
  'every Parallel branch must have an outgoing edge':
    'Every branch of a Parallel step needs a next step.',
  'branches cannot reconverge before Merge is available':
    'Parallel branches join before their Merge step. Connect them to the Merge instead.',
  'node definition is not publishable':
    'A step uses a version that can’t be published any more. Replace it with the current version.',
  'node config version is incompatible':
    'A step’s setup was saved by an older version. Open it and save its setup again.',
};

export function mapWorkflowAuthoringError(error: unknown): ApplicationError {
  if (error instanceof AuthorizationError)
    return applicationError(error.code, {
      safeDetail: error.message,
    });
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
  if (error instanceof WorkflowNameRevisionConflictError)
    return applicationError('workflow.name_conflict', {
      safeDetail:
        'The workflow was renamed meanwhile; reload it before retrying.',
      details: { currentNameRevision: error.currentRevision },
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
  // Compiling the executable finds setup the draft check can't see (a
  // Parallel or Switch edge on a branch that isn't configured): the
  // workflow is invalid, not the server broken.
  if (
    error instanceof WorkflowEngineError &&
    error.code === 'executable_invalid'
  )
    return applicationError('workflow.invalid', {
      safeDetail:
        'A step’s setup is incomplete, so the workflow can’t be published yet.',
      details: {
        issues: [
          {
            path: '$.nodes',
            code: 'executable_invalid',
            message: EXECUTABLE_PROBLEMS[error.message] ?? error.message,
          },
        ],
      },
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
