import { projectContractSchema } from '../schema-projection.js';
import * as schemas from '../../schemas/identity/data-tables.js';
import {
  jsonResponse,
  jsonRequest,
  uuidPathParameter,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  problemResponse,
} from '../primitives.js';
export function dataTableContractSchemas(target: 'client' | 'openapi') {
  const definitions = [
    ['DataTablesResponse', schemas.dataTablesResponseSchema, 'output'],
    ['DataTableSchemaEdit', schemas.dataTableSchemaEditSchema, 'input'],
    ['DataTableSchemaEdited', schemas.dataTableSchemaEditedSchema, 'output'],
    ['DataTableExportQuery', schemas.dataTableExportQuerySchema, 'input'],
    ['DataTableCreate', schemas.dataTableCreateSchema, 'input'],
    ['DataTableCreated', schemas.dataTableCreatedSchema, 'output'],
    ['DataTableRemove', schemas.dataTableRemoveSchema, 'input'],
    ['DataTableRemoved', schemas.dataTableRemovedSchema, 'output'],
    ['DataTableQuery', schemas.dataTableQuerySchema, 'input'],
    ['DataTableResult', schemas.dataTableResultSchema, 'output'],
    ['DataTableWrite', schemas.dataTableWriteSchema, 'input'],
    ['DataTableWriteReceipt', schemas.dataTableWriteReceiptSchema, 'output'],
    ['DataTableImport', schemas.dataTableCsvImportSchema, 'input'],
    ['DataTableImported', schemas.dataTableImportedSchema, 'output'],
    ['DataTableLimits', schemas.dataTableLimitsSchema, 'input'],
    ['DataTableQuotas', schemas.dataTableQuotasSchema, 'output'],
  ] as const;
  return Object.fromEntries(
    definitions.map(([name, schema, io]) => [
      name,
      projectContractSchema(name, schema, io, target),
    ]),
  );
}
function operation(
  operationId: string,
  response: string,
  request?: string,
  table = false,
  write = false,
) {
  return {
    operationId,
    security: [{ cookieSession: [] }],
    parameters: [
      uuidPathParameter('workspaceId'),
      ...(table ? [uuidPathParameter('tableId')] : []),
      ...(request === undefined ? [] : [csrfHeaderParameter()]),
      ...(write ? [idempotencyHeaderParameter()] : []),
    ],
    ...(request === undefined ? {} : { requestBody: jsonRequest(request) }),
    responses: {
      '200': jsonResponse('Workspace data tables', response),
      '400': problemResponse('Invalid values or bounded query'),
      '401': problemResponse('Session required'),
      '403': problemResponse('Not allowed or CSRF refused'),
      '404': problemResponse('Workspace or table unavailable'),
      '409': problemResponse('Revision, unique key or quota conflict'),
      '429': problemResponse('Rate limited'),
      '500': problemResponse('Unexpected failure'),
    },
  };
}
export const dataTableContractPaths = {
  '/v1/workspaces/{workspaceId}/data-tables': {
    get: operation('listDataTables', 'DataTablesResponse'),
    post: operation(
      'createDataTable',
      'DataTableCreated',
      'DataTableCreate',
      false,
      true,
    ),
  },
  '/v1/workspaces/{workspaceId}/data-tables/limits': {
    put: operation(
      'configureDataTableLimits',
      'DataTableQuotas',
      'DataTableLimits',
      false,
      true,
    ),
  },
  '/v1/workspaces/{workspaceId}/data-tables/{tableId}': {
    delete: operation(
      'removeDataTable',
      'DataTableRemoved',
      'DataTableRemove',
      true,
      true,
    ),
  },
  '/v1/workspaces/{workspaceId}/data-tables/{tableId}/schema': {
    put: operation(
      'editDataTableSchema',
      'DataTableSchemaEdited',
      'DataTableSchemaEdit',
      true,
      true,
    ),
  },
  '/v1/workspaces/{workspaceId}/data-tables/{tableId}/export': {
    post: {
      ...operation(
        'exportDataTableCsv',
        'DataTablesResponse',
        'DataTableExportQuery',
        true,
      ),
      parameters: [
        uuidPathParameter('workspaceId'),
        uuidPathParameter('tableId'),
        {
          ...csrfHeaderParameter(),
          required: false,
          description:
            'Required for JSON POST; native form POST supplies csrfToken in its body.',
        },
      ],
      description:
        'Streams the complete filtered CSV in row creation order. Interrupted transfers are aborted. Native forms supply query JSON and csrfToken as URL-encoded fields.',
      requestBody: {
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
      responses: {
        ...operation('exportDataTableCsv', 'DataTablesResponse').responses,
        '200': {
          description:
            'Complete CSV; formula-protected, without a complete-file size cap',
          content: {
            'text/csv': { schema: { type: 'string', format: 'binary' } },
          },
        },
      },
    },
  },
  '/v1/workspaces/{workspaceId}/data-tables/{tableId}/rows/query': {
    post: operation(
      'findDataTableRows',
      'DataTableResult',
      'DataTableQuery',
      true,
    ),
  },
  '/v1/workspaces/{workspaceId}/data-tables/{tableId}/rows': {
    post: operation(
      'writeDataTableRows',
      'DataTableWriteReceipt',
      'DataTableWrite',
      true,
      true,
    ),
  },
  '/v1/workspaces/{workspaceId}/data-tables/{tableId}/import': {
    post: operation(
      'importDataTableCsv',
      'DataTableImported',
      'DataTableImport',
      true,
      true,
    ),
  },
};
