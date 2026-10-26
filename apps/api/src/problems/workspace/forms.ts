import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  FormUnavailableError,
  EventCoordinationUnavailableError,
  FormChangedError,
  FormAccessConflictError,
} from '@pertexo/database/triggers';
import {
  FormFileRejectedError,
  FormValuesInvalidError,
} from '@pertexo/workflow-model';
import { FormUploadLimitError } from '@pertexo/database/runs';
import { applicationError } from '../../platform/http/index.js';

export const formsProblems = [
  errorRegistration(EventCoordinationUnavailableError, () => {
    return applicationError('trigger.coordination_unavailable');
  }),
  errorRegistration(FormUnavailableError, () => {
    return applicationError('form.unavailable', {
      safeDetail:
        'This form is off, unavailable, or waiting for an active publication. Ask its owner for a current link.',
    });
  }),
  errorRegistration(FormChangedError, () => {
    return applicationError('form.changed', {
      safeDetail:
        'The published form changed. Reload the form before sending your response.',
    });
  }),
  errorRegistration(FormAccessConflictError, () => {
    return applicationError('form.access_conflict', {
      safeDetail:
        'Another editor changed this link. Refresh its settings before changing it again.',
    });
  }),
  errorRegistration(FormValuesInvalidError, (error) => {
    return formValidationProblem(error);
  }),
  errorRegistration(FormFileRejectedError, (error) =>
    applicationError(
      error.reason === 'type'
        ? 'form.file_type_not_allowed'
        : 'form.file_too_large',
      { safeDetail: error.message },
    ),
  ),
  errorRegistration(FormUploadLimitError, () =>
    applicationError('form.upload_limit', {
      safeDetail:
        'This response has started too many uploads. Reload the form to start again.',
    }),
  ),
];

function formValidationProblem(error: FormValuesInvalidError) {
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
