import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  NoticeConflictError,
  NoticeUnavailableError,
} from '@pertexo/core/inbox';
import { applicationError } from '../../platform/http/index.js';

export const preferencesProblems = [
  errorRegistration(NoticeConflictError, (error) => {
    return applicationError('notifications.changed', {
      safeDetail: error.message,
    });
  }),
  errorRegistration(NoticeUnavailableError, (error) => {
    return applicationError('notifications.unavailable', {
      safeDetail: error.message,
    });
  }),
];
