import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/policy';

import { responseReference } from '../../openapi/primitives.js';
import {
  nodeTestExecuteAcceptedResponseSchema,
  nodeTestParamsSchema,
  nodeTestRequestSchema,
  nodeValidationResponseSchema,
  previewRunParamsSchema,
  previewRunResponseSchema,
} from '../../schemas/execution/node-testing.js';
import {
  stepSampleCommandResponseSchema,
  stepSampleDeleteRequestSchema,
  stepSampleListResponseSchema,
  stepSampleResponseSchema,
  stepSampleWriteRequestSchema,
} from '../../schemas/workflows/step-samples.js';
import { workflowIdParamSchema } from '../../schemas/workflows/authoring.js';
import { defineRoute, named, type RouteAccess } from '../define.js';

const DRAFT = '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft';
const SAMPLE = `${DRAFT}/nodes/{nodeId}/sample` as const;

export const updatingDraft: RouteAccess = {
  auth: 'session',
  capabilities: [
    {
      name: 'workflow:update',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const readingDraft: RouteAccess = {
  auth: 'session',
  capabilities: [
    {
      name: 'workflow:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const problems = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '500': responseReference('Unexpected'),
};
const projected = { projected: true } as const;
const sampleCommand = named(
  'StepSampleCommandResponse',
  stepSampleCommandResponseSchema,
  projected,
);

export const nodeTestingRoutes = {
  test: defineRoute({
    operationId: 'testWorkflowNode',
    method: 'post',
    path: `${DRAFT}/nodes/{nodeId}/test`,
    params: nodeTestParamsSchema,
    access: updatingDraft,
    rateLimit: 'preview_test',
    idempotent: {
      when: 'request mode is test_execute; ignored for validate',
    },
    body: named('NodeTestRequest', nodeTestRequestSchema, projected),
    success: {
      status: 200,
      description: 'Read-only node validation',
      body: named(
        'NodeValidationResponse',
        nodeValidationResponseSchema,
        projected,
      ),
    },
    otherSuccesses: [
      {
        status: 202,
        description: 'Durable node test execution accepted',
        body: named(
          'NodeTestExecuteAcceptedResponse',
          nodeTestExecuteAcceptedResponseSchema,
          projected,
        ),
      },
    ],
    problems: {
      ...problems,
      '422': responseReference('UnprocessableEntity'),
    },
  }),
  preview: defineRoute({
    operationId: 'getPreviewRun',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/previews/{previewRunId}',
    params: previewRunParamsSchema,
    access: updatingDraft,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Preview run status',
      body: named('PreviewRunResponse', previewRunResponseSchema, projected),
    },
    problems: {
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '500': responseReference('Unexpected'),
    },
  }),
};

export const stepSampleRoutes = {
  list: defineRoute({
    operationId: 'listStepSamples',
    method: 'get',
    path: `${DRAFT}/samples`,
    params: workflowIdParamSchema,
    access: readingDraft,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    success: {
      status: 200,
      description: 'Pinned step metadata, without output payloads',
      body: named(
        'StepSampleListResponse',
        stepSampleListResponseSchema,
        projected,
      ),
    },
    problems,
  }),
  get: defineRoute({
    operationId: 'getStepSample',
    method: 'get',
    path: SAMPLE,
    params: nodeTestParamsSchema,
    access: readingDraft,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    success: {
      status: 200,
      description: 'One pinned sample and its retained value',
      body: named('StepSampleResponse', stepSampleResponseSchema, projected),
    },
    problems,
  }),
  put: defineRoute({
    operationId: 'putStepSample',
    method: 'put',
    path: SAMPLE,
    params: nodeTestParamsSchema,
    access: updatingDraft,
    rateLimit: 'preview_test',
    idempotent: true,
    body: named(
      'StepSampleWriteRequest',
      stepSampleWriteRequestSchema,
      projected,
    ),
    success: {
      status: 200,
      description: 'Saved or confirmed sample identity',
      body: sampleCommand,
    },
    problems,
  }),
  remove: defineRoute({
    operationId: 'removeStepSample',
    method: 'delete',
    path: SAMPLE,
    params: nodeTestParamsSchema,
    access: updatingDraft,
    rateLimit: 'preview_test',
    idempotent: true,
    body: named(
      'StepSampleDeleteRequest',
      stepSampleDeleteRequestSchema,
      projected,
    ),
    success: {
      status: 200,
      description: 'Removed sample identity',
      body: sampleCommand,
    },
    problems,
  }),
};
