import { applicationError } from '../../platform/http/application-error.js';
import { errorRegistration } from '../../platform/http/problems/error-registry.js';
import { requestInputCause } from '../../platform/http/request-input.js';
import {
  FormAdmissionError,
  HiddenResourceError,
  InvalidRequestError,
  WorkflowTestPreparationError,
} from './request-context.errors.js';

export const contextualProblems = [
  errorRegistration(HiddenResourceError, () =>
    applicationError('resource.not_found'),
  ),
  errorRegistration(InvalidRequestError, (error) =>
    applicationError('request.invalid', {
      safeDetail: error.message,
      ...requestInputCause(error.cause),
    }),
  ),
  errorRegistration(WorkflowTestPreparationError, (error) =>
    applicationError('workflow.invalid', {
      safeDetail: error.message,
      ...(error.issues === undefined
        ? {}
        : { details: { issues: error.issues } }),
    }),
  ),
  errorRegistration(FormAdmissionError, (error) =>
    error.reason === 'queue_full'
      ? applicationError('workspace.quota_exceeded', {
          details: { retryAfterSeconds: error.retryAfterSeconds },
        })
      : applicationError('form.unavailable', {
          safeDetail: 'This workspace is not accepting form responses.',
        }),
  ),
];
