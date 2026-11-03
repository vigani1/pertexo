import { callbackPaths } from './callbacks.js';
import { testEventPaths } from './test-events.js';
import { webhookRoutes } from '../../routes/triggers/webhooks.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { apiProblemSchema } from '../../errors/api-problem.js';
import { webhookIngressResponseSchema } from '../../schemas/triggers/webhooks.js';
import {
  authenticatedComponents,
  jsonSchema,
  pathParameter as openApiPathParameter,
  problemResponse,
  responseReference,
  webhookContentTypeHeaderParameter,
} from '../primitives.js';

function pathParameter(name: string, pattern: string) {
  return openApiPathParameter(name, { type: 'string', pattern });
}

const routes = Object.values(webhookRoutes);

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  WebhookIngressResponse: jsonSchema(webhookIngressResponseSchema, 'output'),
  ...routeSchemas(routes),
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

function ingressWorkflowResponse(
  description: string,
  schema: Readonly<Record<string, unknown>> = {},
) {
  return {
    description,
    content: {
      'application/json': { schema },
      'text/plain': { schema: { type: 'string' } },
      'text/csv': { schema: { type: 'string' } },
      'application/xml': { schema: { type: 'string' } },
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/ApiProblem' },
      },
    },
  };
}
export const webhooksOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Webhooks API', version: '1.0.0' },
  components: authenticatedComponents(schemas, responses),
  paths: {
    ...testEventPaths,
    ...callbackPaths,
    ...routePaths(routes),
    '/hooks/{endpointKey}': {
      options: {
        operationId: 'preflightWebhook',
        parameters: [
          pathParameter('endpointKey', '^[A-Za-z0-9_-]{43}$'),
          {
            name: 'Origin',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'Access-Control-Request-Method',
            in: 'header',
            required: true,
            schema: { type: 'string', enum: ['GET', 'POST'] },
          },
          {
            name: 'Access-Control-Request-Headers',
            in: 'header',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '204': {
            description:
              'Allowed endpoint origin and explicit request headers. No run starts; no credentials or wildcard origins.',
          },
          '401': responseReference('Unauthenticated'),
          '429': responseReference('RateLimited'),
          '503': responseReference('Unavailable'),
        },
      },
      get: {
        operationId: 'acceptWebhookGet',
        description:
          'Starts a run from the query string. Signed endpoints refuse GET with 405, because the signature covers the body.',
        parameters: [pathParameter('endpointKey', '^[A-Za-z0-9_-]{43}$')],
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
            'Webhook authentication failed, or the configured workflow response.',
          ),
          '405': ingressWorkflowResponse(
            'Signed endpoint, which accepts POST only.',
          ),
          '409': ingressWorkflowResponse(
            'Idempotency conflict, or the configured workflow response.',
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
      post: {
        operationId: 'acceptWebhook',
        parameters: [
          pathParameter('endpointKey', '^[A-Za-z0-9_-]{43}$'),
          webhookContentTypeHeaderParameter(),
          {
            name: 'X-Pertexo-Timestamp',
            in: 'header',
            description: 'Required only in Signed mode.',
            required: false,
            schema: { type: 'string', pattern: '^\\d{1,16}$' },
          },
          {
            name: 'X-Pertexo-Signature',
            in: 'header',
            description:
              'Required only in Signed mode. Header secret instead uses Authorization: Bearer or the configured named header. Secret URL authenticates with the address alone.',
            required: false,
            schema: { type: 'string', pattern: '^v1=[0-9a-f]{64}$' },
          },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: {} },
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                additionalProperties: { type: 'string' },
              },
            },
            'text/plain': { schema: { type: 'string' } },
          },
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
            'Webhook authentication failed, or the configured workflow response.',
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
