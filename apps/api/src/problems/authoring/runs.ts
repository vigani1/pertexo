import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  ExecutionStateConflictError,
  WorkspaceRunQuotaExceededError,
  WorkspaceRunAdmissionDeniedError,
  WorkflowAlreadyRunningError,
  WorkflowRecoveryUnavailableError,
  WorkflowPublishedVersionConflictError,
  RunVariableSnapshotUnavailableError,
  RunRequiresFormError,
  WorkflowRunNotFoundError as DatabaseWorkflowRunNotFoundError,
  WorkflowRunNotExecutableError as DatabaseWorkflowRunNotExecutableError,
} from '@pertexo/core/runs';
import { CallableInputInvalidError } from '@pertexo/workflow-model';
import {
  type ApplicationError,
  applicationError,
} from '../../platform/http/index.js';
import { WorkflowRunNotFoundError } from '../../workflow-runs/use-cases.js';

export const runProblems = [
  errorRegistration(WorkspaceRunQuotaExceededError, (error) => {
    return applicationError('workspace.quota_exceeded', {
      safeDetail: 'The workspace queued-run limit has been reached.',
      details: { retryAfterSeconds: error.retryAfterSeconds },
    });
  }),
  errorRegistration(WorkspaceRunAdmissionDeniedError, () => {
    return applicationError('workspace.conflict', {
      safeDetail: 'The workspace is not accepting new runs.',
    });
  }),
  errorRegistration(WorkflowAlreadyRunningError, (error) => {
    return applicationError('workflow.already_running', {
      safeDetail: error.message,
    });
  }),
  errorRegistration(WorkflowRunNotFoundError, missingRun),
  errorRegistration(DatabaseWorkflowRunNotFoundError, missingRun),
  errorRegistration(DatabaseWorkflowRunNotExecutableError, unpublishedRun),
  errorRegistration(ExecutionStateConflictError, (error) => {
    if (error.message === 'execution.run_not_found') return missingRun();
    if (
      error.message === 'execution.run_terminal' ||
      error.message === 'execution.cancel_request_conflict'
    )
      return terminalRun();
    return undefined;
  }),
  errorRegistration(WorkflowRecoveryUnavailableError, (error) =>
    applicationError('run.recovery_unavailable', {
      safeDetail: 'The source run no longer qualifies for recovery.',
      details: { reason: error.reason },
    }),
  ),
  errorRegistration(WorkflowPublishedVersionConflictError, () =>
    applicationError('workflow.published_version_conflict', {
      safeDetail:
        'The published version changed. Review the input in the new version context and confirm a new run.',
    }),
  ),
  errorRegistration(RunVariableSnapshotUnavailableError, (error) =>
    applicationError('workflow.variable_snapshot_unavailable', {
      safeDetail: error.message,
    }),
  ),
  errorRegistration(RunRequiresFormError, () =>
    applicationError('form.required', {
      safeDetail:
        'Open this workflow’s form to enter its fields and start a run.',
    }),
  ),
  errorRegistration(CallableInputInvalidError, () => {
    return applicationError('request.invalid', {
      safeDetail:
        'The input does not satisfy this workflow’s callable contract.',
    });
  }),
];

function missingRun(): ApplicationError {
  return applicationError('resource.not_found');
}
function unpublishedRun(): ApplicationError {
  return applicationError('workflow.not_published', {
    safeDetail: 'The workflow has no compatible executable publication.',
  });
}
function terminalRun(): ApplicationError {
  return applicationError('run.not_cancelable', {
    safeDetail: 'The workflow run is already terminal.',
  });
}
