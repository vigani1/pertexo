import {
  UNPURGED_WORKSPACE_STATUSES,
  type AuthorizationCapability,
} from '@pertexo/policy';
import { z } from 'zod';

import { problemResponse } from '../openapi-primitives.js';
import * as schemas from '../../schemas/identity/governance.js';
import { defineRoute, named, type RouteAccess } from '../define.js';

const ROOT = '/v1/workspaces/{workspaceId}/governance';
const workspace = z.object({ workspaceId: z.uuid() }).strict();

/** The audit trail outlives suspension, until the workspace is purged. */
function session(name: AuthorizationCapability): RouteAccess {
  return {
    auth: 'session',
    capabilities: [
      { name, statuses: UNPURGED_WORKSPACE_STATUSES, disclosure: 'not_found' },
    ],
  };
}
const auditing = session('audit:read');
const problems = {
  '400': problemResponse('Invalid request or export bound'),
  '401': problemResponse('Session required'),
  '403': problemResponse('CSRF refused'),
  '404': problemResponse('Workspace or governance access unavailable'),
  '409': problemResponse('Settings changed or export already running'),
  '429': problemResponse('Rate limited'),
  '500': problemResponse('Unexpected failure'),
};
const projected = { projected: true } as const;
const noStore = 'private, no-store';
const settings = {
  status: 200,
  description: 'Workspace governance',
  body: named(
    'GovernanceSettings',
    schemas.governanceSettingsSchema,
    projected,
  ),
};
const filter = named('AuditFilter', schemas.auditFilterSchema, projected);

export const governanceRoutes = {
  audit: defineRoute({
    operationId: 'listAuditEvents',
    method: 'get',
    path: `${ROOT}/audit`,
    params: workspace,
    query: schemas.auditQuerySchema,
    access: auditing,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Workspace governance',
      body: named('AuditPage', schemas.auditPageSchema, projected),
    },
    problems,
  }),
  settings: defineRoute({
    operationId: 'readGovernanceSettings',
    method: 'get',
    path: `${ROOT}/settings`,
    params: workspace,
    access: auditing,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: settings,
    problems,
  }),
  configure: defineRoute({
    operationId: 'configureGovernance',
    method: 'put',
    path: `${ROOT}/settings`,
    params: workspace,
    access: session('governance:manage'),
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    body: named('GovernanceUpdate', schemas.governanceUpdateSchema, projected),
    success: settings,
    problems,
  }),
  export: defineRoute({
    operationId: 'exportAuditCsv',
    method: 'post',
    path: `${ROOT}/audit/export`,
    params: workspace,
    access: { ...auditing, csrf: 'header_or_body' },
    rateLimit: 'data_table_export',
    description:
      'At most 100,000 matching events. No snapshot guarantee. A failure after streaming starts aborts the download. Native form requests carry JSON payload and csrfToken fields; native HTML refusals show safe recovery in the download tab. JSON requests use the CSRF header and retain problem+json errors.',
    body: filter,
    requestDocument: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/AuditFilter' },
        },
        'application/x-www-form-urlencoded': {
          schema: {
            type: 'object',
            required: ['payload', 'csrfToken'],
            additionalProperties: false,
            properties: {
              payload: {
                type: 'string',
                description: 'AuditFilter serialized as JSON',
              },
              csrfToken: { type: 'string' },
            },
          },
        },
      },
    },
    success: {
      status: 200,
      response: {
        description: 'Complete streamed CSV',
        content: { 'text/csv': { schema: { type: 'string' } } },
      },
    },
    problems: Object.fromEntries(
      Object.entries(problems).map(([status, response]) => [
        status,
        {
          ...response,
          content: {
            ...response.content,
            'text/html': { schema: { type: 'string' } },
          },
        },
      ]),
    ),
  }),
};
