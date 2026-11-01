import { WorkspaceAccessDeniedError } from '@pertexo/core/tenant-access';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { ArtifactMetadataNotFoundError } from '@pertexo/core/artifacts';
import {
  WorkflowRunNotExecutableError,
  IdempotencyRequestConflictError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '@pertexo/core/runs';
import {
  CallableInputInvalidError,
  InvalidWorkflowGraphError,
} from '@pertexo/workflow-model';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { z } from 'zod';
import { requestBodyCause } from '../../platform/http/request-body.js';
import {
  FormAdmissionError,
  HiddenResourceError,
  InvalidRequestError,
  WorkflowTestPreparationError,
} from './errors.js';

function hiddenResourceFailure(error: unknown): unknown {
  return error instanceof WorkspaceAccessDeniedError
    ? new HiddenResourceError('The resource is unavailable', { cause: error })
    : error;
}

export function requestFailure(
  error: unknown,
  message = 'The request is invalid.',
): unknown {
  return error instanceof z.ZodError
    ? new InvalidRequestError(message, requestBodyCause(error))
    : error;
}

export function resourceFailure(error: unknown): unknown {
  return hiddenResourceFailure(requestFailure(error));
}

function commandFailure(error: unknown): unknown {
  return error instanceof IdempotencyConflictError
    ? new IdempotencyRequestConflictError()
    : error;
}

export function workspaceFailure(error: unknown): unknown {
  return commandFailure(requestFailure(error));
}

export function authoringFailure(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    const graphInvalid = error.issues.some(
      (issue) => issue.path[0] === 'graph',
    );
    return new InvalidRequestError(
      graphInvalid
        ? 'The workflow graph is invalid.'
        : 'The workflow request is invalid.',
      requestBodyCause(error),
    );
  }
  return resourceFailure(commandFailure(error));
}

export function inputCaseFailure(error: unknown): unknown {
  return authoringFailure(
    requestFailure(error, 'The run-input case request is invalid.'),
  );
}

export function collaborationFailure(error: unknown): unknown {
  return authoringFailure(
    requestFailure(
      error,
      'The discussion or presence request is invalid. Check its fields and limits.',
    ),
  );
}

export function nodeTestingFailure(error: unknown): unknown {
  if (error instanceof WorkflowEngineError)
    return new WorkflowTestPreparationError(
      'The saved draft cannot be tested. Check its step setup and links.',
    );
  if (error instanceof InvalidWorkflowGraphError)
    return new WorkflowTestPreparationError(
      'The workflow cannot be tested in its current form.',
      error.issues,
    );
  if (error instanceof ArtifactMetadataNotFoundError)
    return new InvalidRequestError(
      'An attached file is unavailable or belongs to an expired preview. Upload the file again.',
    );
  return requestFailure(error, 'The step test request is invalid.');
}

export function runFailure(error: unknown): unknown {
  if (error instanceof CallableInputInvalidError) return error;
  if (error instanceof WorkflowEngineError)
    return new WorkflowRunNotExecutableError();
  if (error instanceof z.ZodError || error instanceof TypeError)
    return new InvalidRequestError('The workflow run request is invalid.');
  return hiddenResourceFailure(error);
}

export function connectionFailure(error: unknown): unknown {
  return requestFailure(error, 'The connection request is invalid.');
}

export function artifactFailure(error: unknown): unknown {
  return requestFailure(error, 'The artifact request is invalid.');
}

export function inboxFailure(error: unknown): unknown {
  return resourceFailure(
    requestFailure(error, 'The inbox request is invalid.'),
  );
}

export function dataTableFailure(error: unknown): unknown {
  if (error instanceof z.ZodError)
    return new InvalidRequestError(
      error.issues[0]?.message ?? 'The data table request is invalid.',
    );
  return resourceFailure(error);
}

export function formFailure(error: unknown): unknown {
  if (error instanceof WorkspaceRunQuotaExceededError)
    return new FormAdmissionError('queue_full', error.retryAfterSeconds);
  if (error instanceof WorkspaceRunAdmissionDeniedError)
    return new FormAdmissionError('workspace_closed');
  return hiddenResourceFailure(error);
}

export function formUploadFailure(error: unknown): unknown {
  return formFailure(requestFailure(error, 'The upload request is invalid.'));
}

export function memberFormFailure(error: unknown): unknown {
  return formFailure(requestFailure(error, 'The workflow request is invalid.'));
}
