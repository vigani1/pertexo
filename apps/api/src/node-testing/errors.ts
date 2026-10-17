import { StoredExecutionValueInvalidError } from '@pertexo/database/platform';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import {
  WorkspaceRunQuotaExceededError,
  WorkspaceRunAdmissionDeniedError,
} from '@pertexo/database/runs';
import { WorkflowTestError } from '@pertexo/database/authoring';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { sampleApplicationError } from './samples/errors.js';
import { ArtifactMetadataNotFoundError } from '@pertexo/database/runs';
import { PriorPreviewInputUnavailableError } from '@pertexo/database/previews';
import {
  WorkflowNotFoundError,
  WorkflowStepSampleError,
  WorkflowRevisionConflictError,
} from '@pertexo/database/authoring';
import {
  InvalidWorkflowGraphError,
  WorkflowGraphContractError,
} from '@pertexo/workflow-model';
import { z } from 'zod';

import { AuthorizationError } from '../authorization/index.js';
import {
  applicationError,
  isApplicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import type { NodeValidationIssue } from './validation.js';
import { InvalidAuthenticatedWorkspaceContextError } from '../workspaces/request/authenticated-context-error.js';

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
  if (error instanceof StoredExecutionValueInvalidError)
    return applicationError('workflow.invalid', {
      safeDetail:
        'Keep test input within 256 KB, depth 64 and 10,000 values. Split larger input before testing.',
    });
  if (error instanceof WorkflowEngineError)
    return applicationError('workflow.invalid', {
      safeDetail:
        'The saved draft cannot be tested. Check its step setup and links.',
    });
  if (error instanceof WorkspaceRunQuotaExceededError)
    return applicationError('workspace.quota_exceeded', {
      safeDetail: 'The workspace queued-run limit has been reached.',
      details: { retryAfterSeconds: error.retryAfterSeconds },
    });
  if (error instanceof WorkspaceRunAdmissionDeniedError)
    return applicationError('workspace.conflict', {
      safeDetail: 'The workspace is not accepting new runs.',
    });
  if (error instanceof WorkflowTestError) {
    const messages: Record<WorkflowTestError['reason'], string> = {
      cases_changed:
        'The input cases or variables changed. Prepare the suite again.',
      cases_required: 'Save at least one input case before running the suite.',
      case_invalid:
        'A case names a step missing from this draft. Review its expectations.',
      draft_changed: 'The draft changed. Save and prepare the test again.',
      samples_changed: 'The pins changed. Review them before testing again.',
      not_supported: 'Workflow testing is unavailable on this server.',
      pin_invalid:
        'A branching step’s pin must select a valid output path. Pin a successful result or correct its selectedPort before testing.',
      stale_sample:
        'A pin is stale or expired. Confirm, replace or remove it before testing.',
      effects_changed:
        'The steps with external effects changed. Prepare the test again and review the current list.',
      effects_acknowledgement_required:
        'Confirm the listed steps may cause real external effects before testing.',
      already_running:
        'You already have a test running for this workflow. Cancel it or wait for it to finish.',
      not_found: 'That retained workflow test is unavailable.',
    };
    return applicationError(
      error.reason === 'not_found' ? 'resource.not_found' : 'workflow.invalid',
      { safeDetail: messages[error.reason] },
    );
  }
  if (error instanceof WorkflowStepSampleError)
    return sampleApplicationError(error);
  if (error instanceof IdempotencyConflictError)
    return applicationError('request.idempotency_conflict');
  if (error instanceof ArtifactMetadataNotFoundError)
    return applicationError('request.invalid', {
      safeDetail:
        'An attached file is unavailable or belongs to an expired preview. Upload the file again.',
    });
  if (error instanceof InvalidAuthenticatedWorkspaceContextError)
    return applicationError('request.invalid', { safeDetail: error.message });
  if (
    error instanceof NodeTestRequestError &&
    error.code === 'idempotency_required'
  )
    return applicationError('request.invalid', {
      safeDetail: 'Idempotency-Key is required for test_execute.',
    });
  if (error instanceof AuthorizationError)
    return applicationError(error.code, { safeDetail: error.message });
  if (isApplicationError(error)) return error;
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
