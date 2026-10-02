import { apiProblemSchema } from './errors/api-problem.js';
import {
  workflowPortableManifestSchema,
  workflowExportRequestSchema,
  workflowImportPreviewRequestSchema,
  workflowImportRequestSchema,
  workflowImportPreviewResponseSchema,
  workflowImportResponseSchema,
} from './http/workflow-portability.js';
import {
  authenticatedComponents,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  problemResponse,
  responseReference,
  uuidPathParameter,
} from './openapi-primitives.js';
import { projectContractSchema } from './schema-projection.js';
import type { z } from 'zod';

export * from './http/workflow-portability.js';

function contractSchemas(target: 'client' | 'openapi') {
  const project = (name: string, schema: z.ZodType, io: 'input' | 'output') =>
    projectContractSchema(name, schema, io, target);
  return {
    ApiProblem: project('ApiProblem', apiProblemSchema, 'output'),
    WorkflowPortableManifest: project(
      'WorkflowPortableManifest',
      workflowPortableManifestSchema,
      'output',
    ),
    WorkflowExportRequest: project(
      'WorkflowExportRequest',
      workflowExportRequestSchema,
      'input',
    ),
    WorkflowImportPreviewRequest: project(
      'WorkflowImportPreviewRequest',
      workflowImportPreviewRequestSchema,
      'input',
    ),
    WorkflowImportRequest: project(
      'WorkflowImportRequest',
      workflowImportRequestSchema,
      'input',
    ),
    WorkflowImportPreviewResponse: project(
      'WorkflowImportPreviewResponse',
      workflowImportPreviewResponseSchema,
      'output',
    ),
    WorkflowImportResponse: project(
      'WorkflowImportResponse',
      workflowImportResponseSchema,
      'output',
    ),
  };
}
export const workflowPortabilityClientContract = Object.freeze({
  schemaVersion: '1.0.0',
  schemas: contractSchemas('client'),
});
const workspace = uuidPathParameter('workspaceId', 'Workspace identifier');
const csrf = csrfHeaderParameter();
const noStore = {
  'Cache-Control': {
    required: true,
    schema: { type: 'string', const: 'private, no-store' },
  },
};
const failures = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '422': responseReference('UnprocessableEntity'),
  '500': responseReference('Unexpected'),
  '503': responseReference('Unavailable'),
};
export const workflowPortabilityOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Workflow Portability API', version: '1.0.0' },
  paths: {
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/export': {
      post: {
        operationId: 'exportWorkflow',
        description:
          'Export only the explicitly reviewed saved source. Draft source additionally requires a strong If-Match. No credential bytes or automatic redaction.',
        security: [{ cookieSession: [] }],
        parameters: [
          workspace,
          uuidPathParameter('workflowId', 'Workflow identifier'),
          csrf,
          {
            name: 'If-Match',
            in: 'header',
            required: false,
            description: 'Required for a saved draft source.',
            schema: { type: 'string' },
          },
        ],
        requestBody: jsonRequest('WorkflowExportRequest'),
        responses: {
          '200': {
            ...jsonResponse(
              'Reviewed portable workflow',
              'WorkflowPortableManifest',
            ),
            headers: {
              ...noStore,
              'Content-Disposition': {
                required: true,
                schema: {
                  type: 'string',
                  const: 'attachment; filename="workflow.pertexo.json"',
                },
              },
            },
          },
          ...failures,
          '412': responseReference('PreconditionFailed'),
          '428': responseReference('PreconditionRequired'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/import/preview': {
      post: {
        operationId: 'previewWorkflowImport',
        description:
          'Unpersisted compatibility and explicit destination binding preview. Raw request ceiling is 2097152 UTF-8 bytes; duplicate keys and excessive depth are rejected before schema parsing.',
        security: [{ cookieSession: [] }],
        parameters: [workspace, csrf],
        requestBody: jsonRequest('WorkflowImportPreviewRequest'),
        responses: {
          '200': {
            ...jsonResponse(
              'Advisory compatibility preview',
              'WorkflowImportPreviewResponse',
            ),
            headers: noStore,
          },
          ...failures,
          '413': responseReference('PayloadTooLarge'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/import': {
      post: {
        operationId: 'importWorkflow',
        description:
          'Atomically create an unpublished revision-1 draft. Exact authorized retries discover the original identifier, including after writer rollback. Never publishes or runs.',
        security: [{ cookieSession: [] }],
        parameters: [workspace, csrf, idempotencyHeaderParameter()],
        requestBody: jsonRequest('WorkflowImportRequest'),
        responses: {
          '201': {
            ...jsonResponse('Workflow imported', 'WorkflowImportResponse'),
            headers: {
              ...noStore,
              Location: { required: true, schema: { type: 'string' } },
            },
          },
          ...failures,
          '413': responseReference('PayloadTooLarge'),
        },
      },
    },
  },
  components: authenticatedComponents(contractSchemas('openapi'), {
    BadRequest: problemResponse('Invalid request'),
    Unauthenticated: problemResponse('Authentication required'),
    Forbidden: problemResponse('Forbidden'),
    NotFound: problemResponse('Resource not found'),
    Conflict: problemResponse('Source, compatibility or idempotency conflict'),
    UnprocessableEntity: problemResponse('Unsafe or incompatible workflow'),
    Unexpected: problemResponse('Unexpected server error'),
    Unavailable: problemResponse('Import writer unavailable'),
    PreconditionFailed: problemResponse('Saved draft changed'),
    PreconditionRequired: problemResponse('Draft If-Match required'),
    PayloadTooLarge: problemResponse('Request exceeds portable byte ceiling'),
  }),
});
