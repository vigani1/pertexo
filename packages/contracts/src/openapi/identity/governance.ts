import { projectContractSchema } from '../schema-projection.js';
import * as schemas from '../../schemas/identity/governance.js';
import {
  jsonResponse,
  jsonRequest,
  uuidPathParameter,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  problemResponse,
  queryParameter,
} from '../primitives.js';
export function governanceContractSchemas(target: 'client' | 'openapi') {
  return Object.fromEntries(
    (
      [
        ['AuditFilter', schemas.auditFilterSchema, 'input'],
        ['AuditQuery', schemas.auditQuerySchema, 'input'],
        ['AuditPage', schemas.auditPageSchema, 'output'],
        ['GovernanceSettings', schemas.governanceSettingsSchema, 'output'],
        ['GovernanceUpdate', schemas.governanceUpdateSchema, 'input'],
      ] as const
    ).map(([name, schema, io]) => [
      name,
      projectContractSchema(name, schema, io, target),
    ]),
  );
}
function operation(operationId: string, response: string, request?: string) {
  return {
    operationId,
    security: [{ cookieSession: [] }],
    parameters: [
      uuidPathParameter('workspaceId'),
      ...(request === undefined ? [] : [csrfHeaderParameter()]),
      ...(request === 'GovernanceUpdate' ? [idempotencyHeaderParameter()] : []),
    ],
    ...(request === undefined ? {} : { requestBody: jsonRequest(request) }),
    responses: {
      '200': jsonResponse('Workspace governance', response),
      '400': problemResponse('Invalid request or export bound'),
      '401': problemResponse('Session required'),
      '403': problemResponse('CSRF refused'),
      '404': problemResponse('Workspace or governance access unavailable'),
      '409': problemResponse('Settings changed or export already running'),
      '429': problemResponse('Rate limited'),
      '500': problemResponse('Unexpected failure'),
    },
  };
}
export const governanceContractPaths = {
  '/v1/workspaces/{workspaceId}/governance/audit': {
    get: {
      ...operation('listAuditEvents', 'AuditPage'),
      parameters: [
        uuidPathParameter('workspaceId'),
        ...Object.entries(schemas.auditQuerySchema.shape).map(
          ([name, schema]) => queryParameter(name, schema),
        ),
      ],
    },
  },
  '/v1/workspaces/{workspaceId}/governance/settings': {
    get: operation('readGovernanceSettings', 'GovernanceSettings'),
    put: operation(
      'configureGovernance',
      'GovernanceSettings',
      'GovernanceUpdate',
    ),
  },
  '/v1/workspaces/{workspaceId}/governance/audit/export': {
    post: {
      ...operation('exportAuditCsv', 'AuditPage', 'AuditFilter'),
      description:
        'At most 100,000 matching events. No snapshot guarantee. A failure after streaming starts aborts the download. Native form requests carry JSON payload and csrfToken fields; JSON requests use the CSRF header.',
      responses: {
        ...operation('exportAuditCsv', 'AuditPage', 'AuditFilter').responses,
        '200': {
          description: 'Complete streamed CSV',
          content: { 'text/csv': { schema: { type: 'string' } } },
        },
      },
    },
  },
};
