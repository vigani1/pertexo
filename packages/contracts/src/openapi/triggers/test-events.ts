import { projectContractSchema } from '../schema-projection.js';
import {
  webhookTestEventStartSchema,
  webhookTestEventStartedSchema,
  webhookTestEventSnapshotSchema,
} from '../../schemas/triggers/webhooks.js';
import {
  csrfHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  pathParameter,
  responseReference,
  simpleUuidPathParameter,
} from '../primitives.js';
const root =
  '/v1/workspaces/:workspaceId/workflows/:workflowId/draft/nodes/:nodeId/webhook-test-events';
export const testEventRoutes = [
  { method: 'POST', path: root, requiredHeaders: ['X-CSRF-Token'] },
  { method: 'GET', path: `${root}/:id` },
  { method: 'DELETE', path: `${root}/:id`, requiredHeaders: ['X-CSRF-Token'] },
  ...['GET', 'POST', 'OPTIONS'].map((method) => ({
    method,
    path: '/hooks/:endpointKey/test',
  })),
] as const;
export const testEventSchemas = {
  WebhookTestEventStart: jsonSchema(webhookTestEventStartSchema, 'input'),
  WebhookTestEventStarted: jsonSchema(webhookTestEventStartedSchema, 'output'),
  WebhookTestEventSnapshot: projectContractSchema(
    'WebhookTestEventSnapshot',
    webhookTestEventSnapshotSchema,
    'output',
    'openapi',
  ),
};
const security = [{ cookieSession: [] }] as const;
const parameters = [
  simpleUuidPathParameter('workspaceId'),
  simpleUuidPathParameter('workflowId'),
  pathParameter('nodeId', { type: 'string', minLength: 1, maxLength: 64 }),
];
const problems = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '429': responseReference('RateLimited'),
  '500': responseReference('Unexpected'),
};
const ingress = {
  parameters: [
    pathParameter('endpointKey', {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]{43}$',
    }),
  ],
  responses: {
    '202': {
      description: 'One authenticated request captured, no workflow execution',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { captured: { const: true } },
            required: ['captured'],
            additionalProperties: false,
          },
        },
      },
    },
    '401': responseReference('Unauthenticated'),
    '400': responseReference('BadRequest'),
    '413': responseReference('PayloadTooLarge'),
    '415': responseReference('UnsupportedMediaType'),
    '429': responseReference('RateLimited'),
    '503': responseReference('Unavailable'),
  },
};
export const testEventPaths = {
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/nodes/{nodeId}/webhook-test-events':
    {
      post: {
        operationId: 'listenForWebhookTestEvent',
        security,
        parameters: [...parameters, csrfHeaderParameter('X-CSRF-Token')],
        requestBody: jsonRequest('WebhookTestEventStart'),
        responses: {
          '200': jsonResponse(
            'Temporary test URL and credentials, no-store',
            'WebhookTestEventStarted',
          ),
          ...problems,
        },
      },
    },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/nodes/{nodeId}/webhook-test-events/{id}':
    {
      get: {
        operationId: 'readWebhookTestEvent',
        security,
        parameters: [...parameters, simpleUuidPathParameter('id')],
        responses: {
          '200': jsonResponse(
            'Private temporary test capture, no-store',
            'WebhookTestEventSnapshot',
          ),
          ...problems,
        },
      },
      delete: {
        operationId: 'stopWebhookTestEvent',
        security,
        parameters: [
          ...parameters,
          simpleUuidPathParameter('id'),
          csrfHeaderParameter('X-CSRF-Token'),
        ],
        responses: {
          '204': { description: 'Listener and capture removed' },
          ...problems,
        },
      },
    },
  '/hooks/{endpointKey}/test': {
    get: { ...ingress, operationId: 'captureWebhookTestGet' },
    post: {
      ...ingress,
      operationId: 'captureWebhookTestPost',
      requestBody: {
        required: false,
        content: {
          'application/json': { schema: {} },
          'application/x-www-form-urlencoded': { schema: { type: 'string' } },
          'text/plain': { schema: { type: 'string' } },
        },
      },
    },
    options: {
      operationId: 'preflightWebhookTestEvent',
      parameters: ingress.parameters,
      responses: {
        '204': {
          description:
            'Exact listed browser origin only, no credentials and no capture',
        },
        '401': responseReference('Unauthenticated'),
        '429': responseReference('RateLimited'),
        '503': responseReference('Unavailable'),
      },
    },
  },
};
