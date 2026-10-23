import { errorRegistration } from '../../platform/http/problems/registry.js';
import { applicationError } from '../../platform/http/index.js';
import { InvalidWorkspaceInboxCursorError } from '../../notifications/cursor.js';
import { WorkspaceInboxThreadNotFoundError } from '../../notifications/service.js';

export const inboxProblems = [
  errorRegistration(WorkspaceInboxThreadNotFoundError, () => {
    return applicationError('resource.not_found');
  }),
  errorRegistration(InvalidWorkspaceInboxCursorError, () => {
    return applicationError('request.invalid', {
      safeDetail: 'The inbox cursor is invalid for this request.',
    });
  }),
];
