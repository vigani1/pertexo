import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  NodeTestRequestError,
  NodeTestInvalidError,
} from '../../node-testing/errors.js';
import { StoredExecutionValueInvalidError } from '@pertexo/database/platform';

import { WorkflowTestError } from '@pertexo/database/authoring';

import { sampleApplicationError } from './samples.js';
import {
  PreviewIdempotencyConflictError,
  PriorPreviewInputUnavailableError,
} from '@pertexo/database/previews';
import { WorkflowStepSampleError } from '@pertexo/database/authoring';
import { applicationError } from '../../platform/http/index.js';

export const nodeTestProblems = [
  errorRegistration(PreviewIdempotencyConflictError, () =>
    applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    }),
  ),
  errorRegistration(StoredExecutionValueInvalidError, () => {
    return applicationError('workflow.invalid', {
      safeDetail:
        'Keep test input within 256 KB, depth 64 and 10,000 values. Split larger input before testing.',
    });
  }),

  errorRegistration(WorkflowTestError, (error) => {
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
        'The steps with effects changed. Prepare the test again and review the current list.',
      effects_acknowledgement_required:
        'Confirm the listed steps may change real data before testing.',
      already_running:
        'You already have a test running for this workflow. Cancel it or wait for it to finish.',
      not_found: 'That retained workflow test is unavailable.',
    };
    return applicationError(
      error.reason === 'not_found' ? 'resource.not_found' : 'workflow.invalid',
      { safeDetail: messages[error.reason] },
    );
  }),
  errorRegistration(WorkflowStepSampleError, (error) => {
    return sampleApplicationError(error);
  }),

  errorRegistration(NodeTestRequestError, (error) => {
    if (error.code === 'idempotency_required') {
      return applicationError('request.invalid', {
        safeDetail: 'Idempotency-Key is required for test_execute.',
      });
    }
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  }),
  errorRegistration(NodeTestInvalidError, (error) => {
    return applicationError('workflow.invalid', {
      safeDetail: 'The selected node is not valid for preview.',
      details: { issues: error.issues },
    });
  }),
  errorRegistration(PriorPreviewInputUnavailableError, () => {
    return applicationError('workflow.invalid', {
      safeDetail: 'The selected prior preview output is unavailable.',
    });
  }),
];
