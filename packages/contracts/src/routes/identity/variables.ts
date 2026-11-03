import {
  ACTIVE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { z } from 'zod';

import { problemResponse } from '../../openapi/primitives.js';
import { workspaceIdentifierSchema } from '../../schemas/identity/workspaces.js';
import {
  workspaceVariablesCommandResponseSchema,
  workspaceVariablesRequestSchema,
  workspaceVariablesResponseSchema,
  workspaceVariableUsageQuerySchema,
  workspaceVariableUsageResponseSchema,
} from '../../schemas/identity/variables.js';
import { defineRoute, named, type RouteCapability } from '../define.js';

const VARIABLES_PATH = '/v1/workspaces/{workspaceId}/variables';
const params = z.object({ workspaceId: workspaceIdentifierSchema });
const reading: RouteCapability = {
  name: 'workspace:read',
  statuses: UNPURGED_WORKSPACE_STATUSES,
  disclosure: 'not_found',
};
const shared = {
  params,
  cacheControl: 'private, no-store',
  problems: {
    '400': problemResponse('Invalid request'),
    '401': problemResponse('Session required'),
    '403': problemResponse('CSRF refused'),
    '404': problemResponse('Workspace unavailable'),
    '409': problemResponse('Variables or workflow references changed'),
    '429': problemResponse('Rate limited'),
    '500': problemResponse('Unexpected failure'),
  },
} as const;

export const variableRoutes = {
  read: defineRoute({
    ...shared,
    operationId: 'getWorkspaceVariables',
    method: 'get',
    path: VARIABLES_PATH,
    access: { auth: 'session', capability: reading },
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Non-secret current workspace values',
      body: named(
        'WorkspaceVariablesResponse',
        workspaceVariablesResponseSchema,
      ),
    },
  }),
  replace: defineRoute({
    ...shared,
    operationId: 'replaceWorkspaceVariables',
    method: 'put',
    path: VARIABLES_PATH,
    access: {
      auth: 'session',
      capability: {
        name: 'variable:manage',
        statuses: ACTIVE_WORKSPACE_STATUSES,
        disclosure: 'not_found',
      },
    },
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named('WorkspaceVariablesRequest', workspaceVariablesRequestSchema),
    success: {
      status: 200,
      description:
        'Recorded revision, without copying values into the command receipt',
      body: named(
        'WorkspaceVariablesCommandResponse',
        workspaceVariablesCommandResponseSchema,
      ),
    },
  }),
  usage: defineRoute({
    ...shared,
    operationId: 'listWorkspaceVariableReferences',
    method: 'get',
    path: `${VARIABLES_PATH}/usage`,
    access: { auth: 'session', capability: reading },
    rateLimit: 'authenticated_read',
    query: workspaceVariableUsageQuerySchema,
    success: {
      status: 200,
      description:
        'One bounded page, spanning workflows while its budgets last; follow the cursor to the end before declaring a name unused',
      body: named(
        'WorkspaceVariableUsageResponse',
        workspaceVariableUsageResponseSchema,
      ),
    },
  }),
};
