import { z } from 'zod';

import {
  applicationError,
  isApplicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import { AuthorizationError } from '../workspaces/index.js';
import { InvalidWorkspaceInboxCursorError } from './cursor.js';
import { WorkspaceInboxThreadNotFoundError } from './service.js';

export function mapNotificationError(error: unknown): ApplicationError {
  if (isApplicationError(error)) return error;
  if (error instanceof AuthorizationError)
    return applicationError(error.code, { safeDetail: error.message });
  if (error instanceof WorkspaceInboxThreadNotFoundError)
    return applicationError('resource.not_found');
  if (error instanceof InvalidWorkspaceInboxCursorError)
    return applicationError('request.invalid', {
      safeDetail: 'The inbox cursor is invalid for this request.',
    });
  if (error instanceof z.ZodError)
    return applicationError('request.invalid', {
      safeDetail: 'The inbox request is invalid.',
    });
  return applicationError('internal.unexpected', { cause: error });
}
