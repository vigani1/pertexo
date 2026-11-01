import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  PublicationReviewError,
  WorkflowPromotionError,
  WorkflowErrorSettingsConflictError,
  WorkflowErrorTargetUnavailableError,
  WorkflowInputCaseRevisionConflictError,
  WorkflowInputCaseLimitError,
  WorkflowConcurrencyRevisionConflictError,
  WorkflowConcurrencyLimitUnavailableError,
  WorkflowConcurrencyLimitExceededError,
  WorkflowDefinitionPlacementError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  WorkflowLifecycleRevisionConflictError,
  WorkflowNameRevisionConflictError,
  WorkflowPauseRevisionConflictError,
  WorkflowAutoPauseSettingsRevisionConflictError,
  WorkspaceAutoPauseSettingsRevisionConflictError,
} from '@pertexo/core/authoring';
import { ArtifactMetadataNotFoundError } from '@pertexo/core/artifacts';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { AuthoringValidationUnavailableError } from '@pertexo/workflow-model/server';
import { apiProblemIssueSchema } from '@pertexo/contracts';
import {
  applicationError,
  requestBodyCause,
  type ApplicationError,
} from '../../platform/http/index.js';

import { WorkflowHeaderError } from '../../workflow-authoring/http/preconditions.js';
import { InvalidWorkflowCursorError } from '../../workflow-authoring/cursor.js';
import {
  InvalidWorkflowGraphError,
  WorkflowGraphContractError,
} from '../../workflow-authoring/graph.js';

export const workflowProblems = [
  errorRegistration(WorkflowPromotionError, (error) => {
    return applicationError(
      error.reason === 'unavailable'
        ? 'workflow.promotion_unavailable'
        : 'workflow.promotion_conflict',
      { safeDetail: error.message },
    );
  }),
  errorRegistration(PublicationReviewError, (error) => {
    return applicationError(
      error.reason === 'required'
        ? 'workflow.publish_approval_required'
        : 'workflow.publication_review_conflict',
      { safeDetail: error.message },
    );
  }),
  errorRegistration(ArtifactMetadataNotFoundError, () => {
    return applicationError('request.invalid', {
      safeDetail:
        'An attached file is unavailable or its metadata does not match. Upload the file again before saving or running.',
    });
  }),
  errorRegistration(AuthoringValidationUnavailableError, () => {
    return validationUnavailable();
  }),

  errorRegistration(WorkflowHeaderError, (error) => {
    if (error.code === 'precondition_required') {
      return applicationError('request.precondition_required', {
        safeDetail: 'If-Match is required for this operation.',
      });
    }
    return applicationError('request.invalid', {
      safeDetail: error.message,
    });
  }),
  errorRegistration(InvalidWorkflowCursorError, () => {
    return applicationError('request.invalid', {
      safeDetail: 'The workflow cursor is invalid.',
    });
  }),
  errorRegistration(WorkflowNotFoundError, () => {
    return applicationError('resource.not_found');
  }),
  errorRegistration(WorkflowInputCaseRevisionConflictError, () => {
    return applicationError('workflow.input_case_revision_conflict', {
      safeDetail:
        'The case representation has changed; reload it before confirming a new command.',
    });
  }),
  errorRegistration(WorkflowInputCaseLimitError, () => {
    return applicationError('workflow.input_case_limit_exceeded', {
      safeDetail:
        'The run-input case count or retained storage limit has been reached.',
    });
  }),
  errorRegistration(WorkflowErrorSettingsConflictError, () => {
    return applicationError('workflow.error_policy_conflict', {
      safeDetail:
        'The error workflow setting changed. Reload before trying again.',
    });
  }),
  errorRegistration(WorkflowErrorTargetUnavailableError, () => {
    return applicationError('workflow.error_target_unavailable', {
      safeDetail:
        'Choose a different active workflow published with When a workflow fails.',
    });
  }),
  errorRegistration(WorkflowConcurrencyRevisionConflictError, (error) => {
    return applicationError('workflow.concurrency_revision_conflict', {
      safeDetail:
        'The concurrency setting has changed; reload it before retrying.',
      details: { currentRevision: error.currentRevision },
    });
  }),
  errorRegistration(WorkflowConcurrencyLimitUnavailableError, () => {
    return applicationError('workflow.concurrency_limit_unavailable', {
      safeDetail:
        'A concurrency cap requires an active workspace execution entitlement. Reload the current policy before retrying.',
    });
  }),
  errorRegistration(WorkflowConcurrencyLimitExceededError, (error) => {
    return applicationError('workflow.concurrency_limit_exceeded', {
      safeDetail:
        'The concurrency cap exceeds the current workspace active-run limit. Reload the current policy before retrying.',
      details: { maximum: error.maximum },
    });
  }),
  errorRegistration(WorkflowPauseRevisionConflictError, (error) => {
    return applicationError('workflow.pause_conflict', {
      safeDetail: 'The workflow pause has changed; reload it before retrying.',
      details: { currentPauseRevision: error.currentRevision },
    });
  }),
  errorRegistration(WorkflowAutoPauseSettingsRevisionConflictError, (error) => {
    return applicationError('workflow.auto_pause_settings_conflict', {
      safeDetail:
        'The automatic pause settings have changed; reload them before retrying.',
      details: { currentSettingsRevision: error.currentRevision },
    });
  }),
  errorRegistration(
    WorkspaceAutoPauseSettingsRevisionConflictError,
    (error) => {
      return applicationError('workspace.auto_pause_settings_conflict', {
        safeDetail:
          'The workspace default has changed; reload it before retrying.',
        details: { currentRevision: error.currentRevision },
      });
    },
  ),
  errorRegistration(WorkflowRevisionConflictError, (error) => {
    return applicationError('workflow.revision_conflict', {
      safeDetail: 'The workflow draft has changed; reload it before retrying.',
      details: {
        currentRevision: error.currentRevision,
        currentEtag: error.currentEtag,
      },
    });
  }),
  errorRegistration(WorkflowLifecycleRevisionConflictError, (error) => {
    return applicationError('workflow.lifecycle_conflict', {
      safeDetail:
        'The workflow lifecycle has changed; reload it before retrying.',
      details: { currentLifecycleRevision: error.currentRevision },
    });
  }),
  errorRegistration(WorkflowNameRevisionConflictError, (error) => {
    return applicationError('workflow.name_conflict', {
      safeDetail:
        'The workflow was renamed meanwhile; reload it before retrying.',
      details: { currentNameRevision: error.currentRevision },
    });
  }),
  errorRegistration(WorkflowDefinitionPlacementError, (error) => {
    return applicationError('workflow.invalid', {
      safeDetail:
        'The workflow contains a definition that can no longer be added.',
      details: { issues: error.issues },
    });
  }),
  errorRegistration(InvalidWorkflowGraphError, (error) => {
    if (
      error.issues.some(
        (issue) => !apiProblemIssueSchema.safeParse(issue).success,
      )
    )
      return validationUnavailable();
    return applicationError('workflow.invalid', {
      safeDetail: 'The workflow cannot be published in its current form.',
      details: { issues: error.issues },
    });
  }),
  errorRegistration(WorkflowEngineError, (error) => {
    if (error.code === 'executable_invalid') {
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
    }
    return undefined;
  }),
  errorRegistration(WorkflowGraphContractError, (error) => {
    return applicationError('request.invalid', {
      safeDetail: 'The workflow graph is invalid.',
      ...requestBodyCause(error),
    });
  }),
];

const EXECUTABLE_PROBLEMS: Readonly<Record<string, string>> = {
  'Switch config is invalid':
    'A Switch step’s cases aren’t set up correctly. Open the step and review its cases.',
  'Parallel config is invalid':
    'A Parallel step’s branches aren’t set up correctly. Open the step and review its branches.',
  'Merge config is invalid':
    'A Merge step’s setup isn’t complete. Choose its Parallel step and when it continues.',
  'workflow edge source port is not configured':
    'A step has a link from an output its setup doesn’t define: a Switch case, a Parallel branch or a Timed out path. Add it in the step’s setup, or remove the link.',
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
function validationUnavailable(): ApplicationError {
  return applicationError('workflow.validation_unavailable', {
    safeDetail:
      'Workflow validation is temporarily unavailable. Retry explicitly after a short wait.',
    details: { retryAfterSeconds: 1 },
  });
}
