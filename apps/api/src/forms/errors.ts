import {
  FormUnavailableError,
  EventCoordinationUnavailableError,
  FormChangedError,
  FormAccessConflictError,
} from '@pertexo/database/triggers';
import { WorkspaceAccessDeniedError } from '@pertexo/database/tenant-access';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '@pertexo/database/runs';
import { FormValuesInvalidError } from '@pertexo/workflow-model';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
export async function formOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EventCoordinationUnavailableError)
      return throwApplicationError(
        applicationError('trigger.coordination_unavailable'),
      );
    if (error instanceof FormUnavailableError)
      return throwApplicationError(
        applicationError('form.unavailable', {
          safeDetail:
            'This form is off, unavailable, or waiting for an active publication. Ask its owner for a current link.',
        }),
      );
    if (error instanceof WorkspaceAccessDeniedError)
      return throwApplicationError(applicationError('resource.not_found'));
    if (error instanceof FormChangedError)
      return throwApplicationError(
        applicationError('form.changed', {
          safeDetail:
            'The published form changed. Reload the form before sending your response.',
        }),
      );
    if (error instanceof FormAccessConflictError)
      return throwApplicationError(
        applicationError('form.access_conflict', {
          safeDetail:
            'Another editor changed this link. Refresh its settings before changing it again.',
        }),
      );
    if (error instanceof IdempotencyConflictError)
      return throwApplicationError(
        applicationError('request.idempotency_conflict'),
      );
    if (error instanceof FormValuesInvalidError)
      return throwApplicationError(formValidationProblem(error));
    if (error instanceof WorkspaceRunQuotaExceededError)
      return throwApplicationError(
        applicationError('workspace.quota_exceeded', {
          details: { retryAfterSeconds: error.retryAfterSeconds },
        }),
      );
    if (error instanceof WorkspaceRunAdmissionDeniedError)
      return throwApplicationError(
        applicationError('form.unavailable', {
          safeDetail: 'This workspace is not accepting form responses.',
        }),
      );
    throw error;
  }
}

export function formValidationProblem(error: FormValuesInvalidError) {
  return applicationError('form.invalid', {
    safeDetail: error.message,
    details: {
      issues: error.fields.map(({ name, message }) => ({
        path: name,
        code: 'invalid_value',
        message,
      })),
    },
  });
}
