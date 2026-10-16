import { apiProblemSchema } from '../../errors/api-problem.js';
import {
  webhookDeliveryCursorSchema,
  webhookDeliveryListResponseSchema,
  webhookDeliveryPageLimitSchema,
  webhookIngressResponseSchema,
  webhookManagementCommandResponseSchema,
  webhookRotateSecretRequestSchema,
  webhookTriggerListResponseSchema,
} from '../../schemas/triggers/webhooks.js';
import {
  authenticatedComponents,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  pathParameter as openApiPathParameter,
  problemResponse,
  queryParameter,
  responseReference,
  webhookContentTypeHeaderParameter,
} from '../primitives.js';

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
  WebhookDeliveryListResponse: jsonSchema(
    webhookDeliveryListResponseSchema,
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
  routes: Object.freeze([
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers',
    },
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/deliveries',
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
function ingressWorkflowResponse(
  description: string,
  schema: Readonly<Record<string, unknown>> = {},
) {
  return {
    description,
    content: {
      'application/json': { schema },
      'text/plain': { schema: { type: 'string' } },
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/ApiProblem' },
      },
    },
  };
}
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
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/webhook/deliveries':
      {
        get: {
          operationId: 'listWebhookDeliveries',
          security,
          parameters: [
            workspaceParameter,
            workflowParameter,
            triggerParameter,
            queryParameter('limit', webhookDeliveryPageLimitSchema),
            queryParameter('after', webhookDeliveryCursorSchema),
          ],
          responses: {
            '200': jsonResponse(
              'Retained delivery metadata, newest first',
              'WebhookDeliveryListResponse',
            ),
            '400': responseReference('BadRequest'),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '429': responseReference('RateLimited'),
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
          '202': ingressWorkflowResponse(
            'Immediate mode, timeout or wait overflow returns {runId,replayed}; an opt-in workflow may also choose status 202 with its configured JSON/text body.',
            {
              anyOf: [
                { $ref: '#/components/schemas/WebhookIngressResponse' },
                {},
              ],
            },
          ),
          '400': ingressWorkflowResponse(
            'Invalid request before admission, or the configured workflow response.',
          ),
          '401': ingressWorkflowResponse(
            'Signature authentication failed, or the configured workflow response.',
          ),
          '409': ingressWorkflowResponse(
            'Idempotency conflict, or the configured workflow response.',
          ),
          '413': ingressWorkflowResponse(
            'Ingress body too large, or the configured workflow response.',
          ),
          '415': ingressWorkflowResponse(
            'Unsupported ingress media type, or the configured workflow response.',
          ),
          '429': ingressWorkflowResponse(
            'Ingress rate limit, or the configured workflow response.',
          ),
          '503': ingressWorkflowResponse(
            'Unavailable before acceptance, or the configured workflow response.',
          ),
          '500': ingressWorkflowResponse(
            'Failure before a workflow response returns only {code:"webhook.workflow_failed"}; a workflow may instead choose its own status 500 JSON/text body.',
          ),
          default: ingressWorkflowResponse(
            'Opt-in Respond to webhook result (200–599), with JSON or plain text up to 1 MiB, no-store, nosniff and only the safe header allowlist. Work continues after responding.',
          ),
        },
      },
    },
  },
});
