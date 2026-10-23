import { errorRegistration } from '../../platform/http/problems/registry.js';
import { DataTableError } from '@pertexo/node-sdk';
import { applicationError } from '../../platform/http/index.js';

export const dataTableProblems = [
  errorRegistration(DataTableError, (error) => {
    return applicationError(
      error.code === 'not_found'
        ? 'resource.not_found'
        : ['conflict', 'key_conflict', 'quota_exceeded'].includes(error.code)
          ? 'workspace.conflict'
          : 'request.invalid',
      { safeDetail: error.message },
    );
  }),
];
