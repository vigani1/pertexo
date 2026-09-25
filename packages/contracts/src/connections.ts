import { apiProblemSchema } from './errors/api-problem.js';
import {
  authenticatedComponents,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  queryParameter as requiredQueryParameter,
  responseReference,
} from './openapi-primitives.js';
import {
  connectionCursorSchema,
  connectionCreateRequestSchema,
  connectionIdentifierSchema,
  connectionListResponseSchema,
  connectionPageLimitSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  slackChannelLookupChannelIdsSchema,
  slackChannelLookupResponseSchema,
} from './http/connections.js';
import {
  failureNotificationDestinationAppendVersionRequestSchema,
  failureNotificationDestinationCreateRequestSchema,
  failureNotificationDestinationListResponseSchema,
  failureNotificationDestinationResponseSchema,
  failureNotificationDestinationStatusRequestSchema,
  workflowFailureNotificationPolicyRequestSchema,
  workflowFailureNotificationPolicyResponseSchema,
} from './http/failure-notification-destinations.js';
import type { z } from 'zod';

export * from './http/connections.js';
export * from './http/failure-notification-destinations.js';

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  ConnectionCreateRequest: jsonSchema(connectionCreateRequestSchema, 'input'),
  ConnectionListResponse: jsonSchema(connectionListResponseSchema, 'output'),
  ConnectionResponse: jsonSchema(connectionResponseSchema, 'output'),
  ConnectionRotateSecretRequest: jsonSchema(
    connectionRotateSecretRequestSchema,
    'input',
  ),
  ConnectionTestRequest: jsonSchema(connectionTestRequestSchema, 'input'),
  ConnectionTestResponse: jsonSchema(connectionTestResponseSchema, 'output'),
  SlackChannelLookupResponse: jsonSchema(
    slackChannelLookupResponseSchema,
    'output',
  ),
  FailureNotificationDestinationAppendVersionRequest: jsonSchema(
    failureNotificationDestinationAppendVersionRequestSchema,
    'input',
  ),
  FailureNotificationDestinationCreateRequest: jsonSchema(
    failureNotificationDestinationCreateRequestSchema,
    'input',
  ),
  FailureNotificationDestinationListResponse: jsonSchema(
    failureNotificationDestinationListResponseSchema,
    'output',
  ),
  FailureNotificationDestinationResponse: jsonSchema(
    failureNotificationDestinationResponseSchema,
    'output',
  ),
  FailureNotificationDestinationStatusRequest: jsonSchema(
    failureNotificationDestinationStatusRequestSchema,
    'input',
  ),
  WorkflowFailureNotificationPolicyRequest: jsonSchema(
    workflowFailureNotificationPolicyRequestSchema,
    'input',
  ),
  WorkflowFailureNotificationPolicyResponse: jsonSchema(
    workflowFailureNotificationPolicyResponseSchema,
    'output',
  ),
});

export const connectionsClientContract = Object.freeze({
  schemaVersion: '1.3.0',
  schemas,
});

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  ReauthorizationRequired: problemResponse('Reauthorization required'),
  RateLimited: problemResponse('Rate limited'),
  ServiceUnavailable: problemResponse('Key or provider service unavailable'),
  Unexpected: problemResponse('Unexpected server error'),
});

const workspaceParameter = {
  name: 'workspaceId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const;
const connectionParameter = {
  name: 'connectionId',
  in: 'path',
  required: true,
  schema: jsonSchema(connectionIdentifierSchema, 'input'),
} as const;
const destinationParameter = {
  name: 'destinationId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const;
const workflowParameter = {
  name: 'workflowId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const;
const csrfParameter = csrfHeaderParameter();
const idempotencyParameter = idempotencyHeaderParameter();

export const connectionsOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Connections API', version: '1.3.0' },
  paths: {
    '/v1/workspaces/{workspaceId}/connections': {
      get: {
        operationId: 'listConnections',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          queryParameter('limit', connectionPageLimitSchema),
          queryParameter('after', connectionCursorSchema),
        ],
        responses: {
          '200': jsonResponse('Connections', 'ConnectionListResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
      post: {
        operationId: 'createConnection',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, csrfParameter, idempotencyParameter],
        requestBody: jsonRequest('ConnectionCreateRequest'),
        responses: {
          '201': jsonResponse('Connection created', 'ConnectionResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '503': responseReference('ServiceUnavailable'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/connections/{connectionId}/secret': {
      put: {
        operationId: 'rotateConnectionSecret',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          connectionParameter,
          csrfParameter,
          idempotencyParameter,
        ],
        requestBody: jsonRequest('ConnectionRotateSecretRequest'),
        responses: {
          '200': jsonResponse(
            'Connection secret rotated',
            'ConnectionResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '503': responseReference('ServiceUnavailable'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/connections/{connectionId}': {
      get: {
        operationId: 'getConnection',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, connectionParameter],
        responses: {
          '200': jsonResponse('Connection', 'ConnectionResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
      delete: {
        operationId: 'revokeConnection',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, connectionParameter, csrfParameter],
        responses: {
          '200': jsonResponse('Connection revoked', 'ConnectionResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/connections/{connectionId}/test': {
      post: {
        operationId: 'testConnection',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          connectionParameter,
          csrfParameter,
          idempotencyParameter,
        ],
        requestBody: jsonRequest('ConnectionTestRequest'),
        responses: {
          '200': jsonResponse(
            'Connection test completed',
            'ConnectionTestResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '503': responseReference('ServiceUnavailable'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/connections/{connectionId}/slack/channels': {
      get: {
        operationId: 'lookupSlackChannels',
        description:
          'Resolves up to ten Slack channel IDs to names with the connection bot token (ADR 046). Channels that cannot be resolved are returned as unresolved with a reason.',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          connectionParameter,
          requiredQueryParameter(
            'channelIds',
            slackChannelLookupChannelIdsSchema,
            true,
          ),
        ],
        responses: {
          '200': jsonResponse(
            'Channel names, in request order',
            'SlackChannelLookupResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '429': responseReference('RateLimited'),
          '503': responseReference('ServiceUnavailable'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/failure-notification-destinations': {
      get: {
        operationId: 'listFailureNotificationDestinations',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter],
        responses: {
          '200': jsonResponse(
            'Failure notification destinations',
            'FailureNotificationDestinationListResponse',
          ),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
      post: {
        operationId: 'createFailureNotificationDestination',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, csrfParameter, idempotencyParameter],
        requestBody: jsonRequest('FailureNotificationDestinationCreateRequest'),
        responses: {
          '201': jsonResponse(
            'Failure notification destination created',
            'FailureNotificationDestinationResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/failure-notification-destinations/{destinationId}':
      {
        get: {
          operationId: 'getFailureNotificationDestination',
          security: [{ cookieSession: [] }],
          parameters: [workspaceParameter, destinationParameter],
          responses: {
            '200': jsonResponse(
              'Failure notification destination',
              'FailureNotificationDestinationResponse',
            ),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '500': responseReference('Unexpected'),
          },
        },
      },
    '/v1/workspaces/{workspaceId}/failure-notification-destinations/{destinationId}/versions':
      {
        post: {
          operationId: 'appendFailureNotificationDestinationVersion',
          security: [{ cookieSession: [] }],
          parameters: [
            workspaceParameter,
            destinationParameter,
            csrfParameter,
            idempotencyParameter,
          ],
          requestBody: jsonRequest(
            'FailureNotificationDestinationAppendVersionRequest',
          ),
          responses: {
            '200': jsonResponse(
              'Failure notification destination version appended',
              'FailureNotificationDestinationResponse',
            ),
            '400': responseReference('BadRequest'),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '409': responseReference('Conflict'),
            '500': responseReference('Unexpected'),
          },
        },
      },
    '/v1/workspaces/{workspaceId}/failure-notification-destinations/{destinationId}/status':
      {
        put: {
          operationId: 'setFailureNotificationDestinationStatus',
          security: [{ cookieSession: [] }],
          parameters: [
            workspaceParameter,
            destinationParameter,
            csrfParameter,
            idempotencyParameter,
          ],
          requestBody: jsonRequest(
            'FailureNotificationDestinationStatusRequest',
          ),
          responses: {
            '200': jsonResponse(
              'Failure notification destination status changed',
              'FailureNotificationDestinationResponse',
            ),
            '400': responseReference('BadRequest'),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '409': responseReference('Conflict'),
            '500': responseReference('Unexpected'),
          },
        },
      },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/failure-notification-policy':
      {
        get: {
          operationId: 'getWorkflowFailureNotificationPolicy',
          security: [{ cookieSession: [] }],
          parameters: [workspaceParameter, workflowParameter],
          responses: {
            '200': jsonResponse(
              'Failure notification policy',
              'WorkflowFailureNotificationPolicyResponse',
            ),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '500': responseReference('Unexpected'),
          },
        },
        put: {
          operationId: 'setWorkflowFailureNotificationPolicy',
          security: [{ cookieSession: [] }],
          parameters: [
            workspaceParameter,
            workflowParameter,
            csrfParameter,
            idempotencyParameter,
          ],
          requestBody: jsonRequest('WorkflowFailureNotificationPolicyRequest'),
          responses: {
            '204': { description: 'Failure notification policy set' },
            '400': responseReference('BadRequest'),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '409': responseReference('Conflict'),
            '500': responseReference('Unexpected'),
          },
        },
        delete: {
          operationId: 'clearWorkflowFailureNotificationPolicy',
          security: [{ cookieSession: [] }],
          parameters: [
            workspaceParameter,
            workflowParameter,
            csrfParameter,
            idempotencyParameter,
          ],
          responses: {
            '204': { description: 'Failure notification policy cleared' },
            '400': responseReference('BadRequest'),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '409': responseReference('Conflict'),
            '500': responseReference('Unexpected'),
          },
        },
      },
  },
  components: authenticatedComponents(schemas, problemResponses),
});

function queryParameter(name: 'limit' | 'after', schema: z.ZodType) {
  return {
    name,
    in: 'query',
    required: false,
    schema: jsonSchema(schema, 'input'),
  } as const;
}
