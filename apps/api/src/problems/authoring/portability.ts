import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  WorkflowPortabilityUnavailableError,
  WorkflowTemplateOriginUnavailableError,
  WorkflowPortabilityCompatibilityConflictError,
  WorkflowPortabilityReviewConflictError,
  WorkflowPortabilityValidationError,
} from '@pertexo/core/authoring';
import { applicationError } from '../../platform/http/index.js';

export const portabilityProblems = [
  errorRegistration(WorkflowTemplateOriginUnavailableError, () => {
    return applicationError('workflow.template_origin_unavailable', {
      safeDetail: 'Historical template origin is temporarily unavailable.',
    });
  }),
  errorRegistration(WorkflowPortabilityUnavailableError, () => {
    return applicationError('workflow.portability_unavailable', {
      safeDetail:
        'New workflow imports are unavailable. Exact accepted commands can still be retried.',
    });
  }),
  errorRegistration(WorkflowPortabilityCompatibilityConflictError, () => {
    return applicationError('workflow.portability_compatibility_conflict', {
      safeDetail:
        'The destination catalog changed. Preview the import again before creating it.',
    });
  }),
  errorRegistration(WorkflowPortabilityReviewConflictError, () => {
    return applicationError('workflow.portability_review_conflict', {
      safeDetail:
        'The source no longer matches the reviewed content. Review the current saved source before exporting.',
    });
  }),
  errorRegistration(WorkflowPortabilityValidationError, () => {
    return applicationError('workflow.portability_invalid', {
      safeDetail:
        'The portable workflow is unsafe or incompatible. Review the import preview.',
    });
  }),
];
