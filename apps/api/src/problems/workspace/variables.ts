import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  WorkspaceVariablesConflictError,
  WorkspaceVariableUsageChangedError,
} from '@pertexo/core/variables';
import { applicationError } from '../../platform/http/index.js';

export const variablesProblems = [
  errorRegistration(WorkspaceVariablesConflictError, () => {
    return applicationError('variables.changed', {
      safeDetail:
        'Someone changed the workspace variables. Your edits are kept; reload the latest set before saving again.',
    });
  }),
  errorRegistration(WorkspaceVariableUsageChangedError, () => {
    return applicationError('variables.usage_changed', {
      safeDetail:
        'A workflow changed during this reference check. Restart the check for current results.',
    });
  }),
];
