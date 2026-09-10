export * from './http/webhooks.js';

import { apiProblemSchema } from './errors/api-problem.js';
import {
  webhookIngressResponseSchema,
  webhookManagementCommandResponseSchema,
  webhookRotateSecretRequestSchema,
  webhookTriggerListResponseSchema,
} from './http/webhooks.js';
import {
  authenticatedComponents,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  pathParameter as openApiPathParameter,
  problemResponse,
  responseReference,
  webhookContentTypeHeaderParameter,
} from './openapi-primitives.js';

function pathParameter(name: string, pattern?: string) {
  return openApiPathParameter(name, {
    type: 'string',
    ...(pattern === undefined ? { format: 'uuid' } : { pattern }),
  });
}

const workspaceParameter = pathParameter('workspaceId');
const workflowParameter = pathParameter('workflowId');
const triggerParameter = pathParameter('triggerId');
const idempotencyParameter = idempotencyHeaderParameter();
const csrfParameter = csrfHeaderParameter('X-CSRF-Token');
const managementParameters = [
  workspaceParameter,
  workflowParameter,
  triggerParameter,
  idempotencyParameter,
  csrfParameter,
] as const;
const security = [{ cookieSession: [] }] as const;

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  WebhookIngressResponse: jsonSchema(webhookIngressResponseSchema, 'output'),
  WebhookManagementCommandResponse: jsonSchema(
    webhookManagementCommandResponseSchema,
    'output',
  ),
  WebhookRotateSecretRequest: jsonSchema(
    webhookRotateSecretRequestSchema,
    'input',
  ),
  WebhookTriggerListResponse: jsonSchema(
    webhookTriggerListResponseSchema,
    'output',
  ),
});
const responses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  PayloadTooLarge: problemResponse('Payload too large'),
  UnsupportedMediaType: problemResponse('Unsupported media type'),
  RateLimited: problemResponse('Rate limited'),
  Unavailable: problemResponse('Service unavailable'),
  Unexpected: problemResponse('Unexpected server error'),
});

export const webhooksClientContract = Object.freeze({
  schemaVersion: 1,
  routes: Object.freeze([
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers',
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/provision',
      requiredHeaders: ['Idempotency-Key', 'X-CSRF-Token'],
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/rotate-endpoint',
      requiredHeaders: ['Idempotency-Key', 'X-CSRF-Token'],
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/rotate-secret',
      requiredHeaders: ['Idempotency-Key', 'X-CSRF-Token'],
    },
    {
      method: 'POST',
      path: '/hooks/:endpointKey',
      requiredHeaders: [
        'Content-Type',
        'X-Pertexo-Timestamp',
        'X-Pertexo-Signature',
      ],
      maximumBodyBytes: 262_144,
    },
  ]),
});

const managementPath = {
  post: {
    security,
    parameters: managementParameters,
    responses: {
      '200': jsonResponse(
        'Webhook trigger command completed',
        'WebhookManagementCommandResponse',
      ),
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': responseReference('Conflict'),
      '500': responseReference('Unexpected'),
    },
  },
} as const;
const rotateSecretPath = {
  post: {
    ...managementPath.post,
    requestBody: jsonRequest('WebhookRotateSecretRequest'),
  },
} as const;

export const webhooksOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Webhooks API', version: '1.0.0' },
  components: authenticatedComponents(schemas, responses),
  paths: {
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers': {
      get: {
        operationId: 'listWebhookTriggers',
        security,
        parameters: [workspaceParameter, workflowParameter],
        responses: {
          '200': jsonResponse(
            'Published trigger health',
            'WebhookTriggerListResponse',
          ),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/webhook/provision':
      managementPath,
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/webhook/rotate-endpoint':
      managementPath,
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/webhook/rotate-secret':
      rotateSecretPath,
    '/hooks/{endpointKey}': {
      post: {
        operationId: 'acceptWebhook',
        parameters: [
          pathParameter('endpointKey', '^[A-Za-z0-9_-]{43}$'),
          webhookContentTypeHeaderParameter(),
          {
            name: 'X-Pertexo-Timestamp',
            in: 'header',
            required: true,
            schema: { type: 'string', pattern: '^\\d{1,16}$' },
          },
          {
            name: 'X-Pertexo-Signature',
            in: 'header',
            required: true,
            schema: { type: 'string', pattern: '^v1=[0-9a-f]{64}$' },
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {} } },
        },
        responses: {
          '202': jsonResponse(
            'Workflow run accepted',
            'WebhookIngressResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '409': responseReference('Conflict'),
          '413': responseReference('PayloadTooLarge'),
          '415': responseReference('UnsupportedMediaType'),
          '429': responseReference('RateLimited'),
          '503': responseReference('Unavailable'),
          '500': responseReference('Unexpected'),
        },
      },
    },
  },
});
