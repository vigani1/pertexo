import {
  WorkflowPortabilityUnavailableError,
  WorkflowTemplateOriginUnavailableError,
  WorkflowPortabilityCompatibilityConflictError,
  WorkflowPortabilityReviewConflictError,
  WorkflowPortabilityValidationError,
} from '@pertexo/database/api';
import {
  applicationError,
  type ApplicationError,
} from '../platform/http/index.js';

/** Existing portability/origin failures retain their exact transport mapping. */
export function mapWorkflowPortabilityError(
  error: unknown,
): ApplicationError | undefined {
  if (error instanceof WorkflowTemplateOriginUnavailableError)
    return applicationError('workflow.template_origin_unavailable', {
      safeDetail: 'Historical template origin is temporarily unavailable.',
    });
  if (error instanceof WorkflowPortabilityUnavailableError)
    return applicationError('workflow.portability_unavailable', {
      safeDetail:
        'New workflow imports are unavailable. Exact accepted commands can still be retried.',
    });
  if (error instanceof WorkflowPortabilityCompatibilityConflictError)
    return applicationError('workflow.portability_compatibility_conflict', {
      safeDetail:
        'The destination catalog changed. Preview the import again before creating it.',
    });
  if (error instanceof WorkflowPortabilityReviewConflictError)
    return applicationError('workflow.portability_review_conflict', {
      safeDetail:
        'The source no longer matches the reviewed content. Review the current saved source before exporting.',
    });
  if (error instanceof WorkflowPortabilityValidationError)
    return applicationError('workflow.portability_invalid', {
      safeDetail:
        'The portable workflow is unsafe or incompatible. Review the import preview.',
    });
  return undefined;
}
