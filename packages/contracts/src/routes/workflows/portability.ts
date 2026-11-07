import { workflowPortableManifestSchema } from '@pertexo/workflow-model';
import { z } from 'zod';
import { jsonRequest, problemResponse } from '../openapi-primitives.js';
import { workflowIdParamSchema } from '../../schemas/workflows/authoring.js';
import * as schemas from '../../schemas/workflows/portability.js';
import { projected, reading, session, workspaceParams } from './access.js';

import { responseReference } from '../openapi-primitives.js';
import { defineRoute } from '../define.js';
const sharedProblems1 = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('PortabilityConflict'),
  '413': responseReference('PortabilityPayloadTooLarge'),
  '422': responseReference('PortabilityUnprocessable'),
  '429': problemResponse('Rate limited; see Retry-After'),
  '500': responseReference('Unexpected'),
  '503': responseReference('PortabilityUnavailable'),
};
export const portabilityRoutes = {
  export: defineRoute({
    operationId: 'exportWorkflow',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/export',
    params: workflowIdParamSchema,
    access: { ...reading, auth: 'session_or_token' } as const,
    rateLimit: 'workflow_compile',
    description:
      'Export only the explicitly reviewed retained draft or version, including archived workflows in browsable workspaces. Draft source additionally requires a strong If-Match. No credential bytes or automatic redaction.',
    cacheControl: 'private, no-store',
    requestDocument: jsonRequest('WorkflowExportRequest'),
    precondition: {
      when: 'source.kind=draft',
      description: 'Required for a saved draft source.',
      schema: z.string(),
    },
    body: projected(
      'WorkflowExportRequest',
      schemas.workflowExportRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Reviewed portable workflow',
      body: projected(
        'WorkflowPortableManifest',
        workflowPortableManifestSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
        'Content-Disposition': {
          required: true,
          schema: {
            type: 'string',
            const: 'attachment; filename="workflow.pertexo.json"',
          },
        },
      },
    },
    problems: {
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': responseReference('PortabilityConflict'),
      '412': responseReference('PreconditionFailed'),
      '422': responseReference('PortabilityUnprocessable'),
      '428': responseReference('PortabilityPreconditionRequired'),
      '429': problemResponse('Rate limited; see Retry-After'),
      '500': responseReference('Unexpected'),
      '503': responseReference('PortabilityUnavailable'),
    },
  }),
  preview: defineRoute({
    operationId: 'previewWorkflowImport',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/import/preview',
    params: workspaceParams,
    access: {
      ...session('workflow:create'),
      auth: 'session_or_token',
    } as const,
    rateLimit: 'workflow_compile',
    description:
      'Unpersisted compatibility and explicit destination binding preview. Explicit connection bindings additionally require connection:read. Raw request ceiling is 2097152 UTF-8 bytes; duplicate keys and excessive depth are rejected before schema parsing.',
    cacheControl: 'private, no-store',
    requestDocument: jsonRequest('WorkflowImportPreviewRequest'),
    body: projected(
      'WorkflowImportPreviewRequest',
      schemas.workflowImportPreviewRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Advisory compatibility preview',
      body: projected(
        'WorkflowImportPreviewResponse',
        schemas.workflowImportPreviewResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    problems: sharedProblems1,
  }),
  import: defineRoute({
    operationId: 'importWorkflow',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/import',
    params: workspaceParams,
    access: {
      ...session('workflow:create'),
      auth: 'session_or_token',
    } as const,
    rateLimit: 'workflow_compile',
    description:
      'Atomically create an unpublished revision-1 draft. Exact authorized retries discover the original identifier, including after writer rollback. Never publishes or runs. Explicit connection bindings additionally require connection:read.',
    cacheControl: 'private, no-store',
    requestDocument: jsonRequest('WorkflowImportRequest'),
    body: projected(
      'WorkflowImportRequest',
      schemas.workflowImportRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 201,
      description: 'Workflow imported',
      body: projected(
        'WorkflowImportResponse',
        schemas.workflowImportResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
        Location: { required: true, schema: { type: 'string' } },
      },
    },
    problems: sharedProblems1,
  }),
};
