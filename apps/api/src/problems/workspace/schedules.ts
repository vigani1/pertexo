import { errorRegistration } from '../../platform/http/problems/registry.js';
import { ScheduleTriggerError } from '@pertexo/core/triggers';
import { applicationError } from '../../platform/http/index.js';
import { InvalidScheduleOccurrenceCursorError } from '../../schedules/cursor.js';

export const schedulesProblems = [
  errorRegistration(InvalidScheduleOccurrenceCursorError, () => {
    return applicationError('request.invalid', {
      safeDetail: 'The occurrence cursor is invalid.',
    });
  }),
  errorRegistration(ScheduleTriggerError, (error) => {
    switch (error.code) {
      case 'not_found':
        return applicationError('resource.not_found');
      case 'invalid_recurrence':
        return applicationError('request.invalid', {
          safeDetail:
            'The schedule rule cannot be scheduled. Check the cron fields and the timezone.',
        });
      case 'idempotency_conflict':
        return applicationError('request.idempotency_conflict', {
          safeDetail:
            'The idempotency key was already used for another request.',
        });
    }
  }),
];
