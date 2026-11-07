import {
  ACTIVE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { z } from 'zod';

import { problemResponse } from '../openapi-primitives.js';
import * as schemas from '../../schemas/identity/data-tables.js';
import { workspaceIdentifierSchema } from '../../schemas/identity/workspaces.js';
import { defineRoute, named, type RouteAccess } from '../define.js';

const ROOT = '/v1/workspaces/{workspaceId}/data-tables';
const TABLE = `${ROOT}/{tableId}` as const;
const workspace = z.object({ workspaceId: workspaceIdentifierSchema });
const table = workspace.extend({ tableId: workspaceIdentifierSchema });

const reading: RouteAccess = {
  auth: 'session_or_token',
  capabilities: [
    {
      name: 'workspace:read',
      statuses: UNPURGED_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const managing: RouteAccess = {
  auth: 'session_or_token',
  capabilities: [
    {
      name: 'workflow:update',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const problems = {
  '400': problemResponse('Invalid values or bounded query'),
  '401': problemResponse('Session required'),
  '403': problemResponse('Not allowed or CSRF refused'),
  '404': problemResponse('Workspace or table unavailable'),
  '409': problemResponse('Revision, unique key or quota conflict'),
  '429': problemResponse('Rate limited'),
  '500': problemResponse('Unexpected failure'),
};
const shared = { cacheControl: 'private, no-store', problems } as const;
// Table values are recursive JSON, which needs the shared projection.
const projected = <Schema extends z.ZodType>(name: string, schema: Schema) =>
  named(name, schema, { projected: true });
const answer = <Schema extends z.ZodType>(name: string, schema: Schema) => ({
  status: 200,
  description: 'Workspace data tables',
  body: projected(name, schema),
});

export const dataTableRoutes = {
  list: defineRoute({
    ...shared,
    operationId: 'listDataTables',
    method: 'get',
    path: ROOT,
    params: workspace,
    access: reading,
    rateLimit: 'authenticated_read',
    success: answer('DataTablesResponse', schemas.dataTablesResponseSchema),
  }),
  create: defineRoute({
    ...shared,
    operationId: 'createDataTable',
    method: 'post',
    path: ROOT,
    params: workspace,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: projected('DataTableCreate', schemas.dataTableCreateSchema),
    success: {
      ...answer('DataTableCreated', schemas.dataTableCreatedSchema),
      status: 201,
    },
  }),
  limits: defineRoute({
    ...shared,
    operationId: 'configureDataTableLimits',
    method: 'put',
    path: `${ROOT}/limits`,
    params: workspace,
    access: { ...managing, auth: 'session' },
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: projected('DataTableLimits', schemas.dataTableLimitsSchema),
    success: answer('DataTableQuotas', schemas.dataTableQuotasSchema),
  }),
  remove: defineRoute({
    ...shared,
    operationId: 'removeDataTable',
    method: 'delete',
    path: TABLE,
    params: table,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: projected('DataTableRemove', schemas.dataTableRemoveSchema),
    success: answer('DataTableRemoved', schemas.dataTableRemovedSchema),
  }),
  editSchema: defineRoute({
    ...shared,
    operationId: 'editDataTableSchema',
    method: 'put',
    path: `${TABLE}/schema`,
    params: table,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: projected('DataTableSchemaEdit', schemas.dataTableSchemaEditSchema),
    success: answer(
      'DataTableSchemaEdited',
      schemas.dataTableSchemaEditedSchema,
    ),
  }),
  export: defineRoute({
    problems,
    operationId: 'exportDataTableCsv',
    method: 'post',
    path: `${TABLE}/export`,
    params: table,
    access: { ...reading, auth: 'session', csrf: 'header_or_body' },
    rateLimit: 'data_table_export',
    description:
      'Streams the complete filtered CSV in row creation order. Interrupted transfers are aborted. Native forms supply query JSON and csrfToken as URL-encoded fields.',
    body: projected('DataTableExportQuery', schemas.dataTableExportQuerySchema),
    requestDocument: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/DataTableExportQuery' },
        },
        'application/x-www-form-urlencoded': {
          schema: {
            type: 'object',
            required: ['payload', 'csrfToken'],
            additionalProperties: false,
            properties: {
              payload: {
                type: 'string',
                description: 'DataTableExportQuery serialized as JSON',
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
        description:
          'Complete CSV; formula-protected, without a complete-file size cap',
        content: {
          'text/csv': { schema: { type: 'string', format: 'binary' } },
        },
      },
    },
  }),
  find: defineRoute({
    ...shared,
    operationId: 'findDataTableRows',
    method: 'post',
    path: `${TABLE}/rows/query`,
    params: table,
    access: reading,
    rateLimit: 'authenticated_read',
    body: projected('DataTableQuery', schemas.dataTableQuerySchema),
    success: answer('DataTableResult', schemas.dataTableResultSchema),
  }),
  write: defineRoute({
    ...shared,
    operationId: 'writeDataTableRows',
    method: 'post',
    path: `${TABLE}/rows`,
    params: table,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: projected('DataTableWrite', schemas.dataTableWriteSchema),
    success: answer(
      'DataTableWriteReceipt',
      schemas.dataTableWriteReceiptSchema,
    ),
  }),
  importCsv: defineRoute({
    ...shared,
    operationId: 'importDataTableCsv',
    method: 'post',
    path: `${TABLE}/import`,
    params: table,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: projected('DataTableImport', schemas.dataTableCsvImportSchema),
    success: answer('DataTableImported', schemas.dataTableImportedSchema),
  }),
};
