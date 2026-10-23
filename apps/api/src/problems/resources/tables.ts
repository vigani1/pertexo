import type { ApiProblemCode } from '@pertexo/contracts';
import { errorRegistration } from '../../platform/http/problems/registry.js';
import { DataTableError } from '@pertexo/node-sdk';
import { applicationError } from '../../platform/http/index.js';

export const dataTableProblems = [
  errorRegistration(DataTableError, (error) => {
    return applicationError(
      TABLE_PROBLEMS.get(error.code) ?? 'request.invalid',
      { safeDetail: error.message },
    );
  }),
];

const TABLE_PROBLEMS = new Map<DataTableError['code'], ApiProblemCode>([
  ['not_found', 'resource.not_found'],
  ['conflict', 'workspace.conflict'],
  ['key_conflict', 'workspace.conflict'],
  ['quota_exceeded', 'workspace.conflict'],
]);
