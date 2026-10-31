import { apiProblemSchema } from '../errors/api-problem.js';
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
} from './primitives.js';
import {
  connectionSharingRequestSchema,
  connectionSharingResponseSchema,
  connectionSharingCommandResponseSchema,
  connectionCursorSchema,
  connectionCreateRequestSchema,
  connectionIdentifierSchema,
  connectionListResponseSchema,
  connectionPageLimitSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  connectionUsageResponseSchema,
  slackChannelLookupChannelIdsSchema,
  slackChannelLookupResponseSchema,
} from '../schemas/connections.js';
import {
  OAUTH2_CALLBACK_PATH,
  OAUTH2_LANDING_PATH,
  oauth2AuthorizationStartResponseSchema,
  oauth2CallbackCodeSchema,
  oauth2CallbackErrorSchema,
  oauth2CallbackLandingSchema,
  oauth2CallbackQuerySchema,
  oauth2CallbackStateSchema,
  oauth2ClientSettingsSchema,
  oauth2ConnectionErrorCodeSchema,
  oauth2ConnectionResponseSchema,
  oauth2CredentialSchema,
  oauth2StepFailureCodeSchema,
} from '../schemas/oauth2-connections.js';
import {
  failureNotificationDestinationAppendVersionRequestSchema,
  failureNotificationDestinationCreateRequestSchema,
  failureNotificationDestinationListResponseSchema,
  failureNotificationDestinationResponseSchema,
  failureNotificationDestinationStatusRequestSchema,
  failureNotificationDestinationTestRequestSchema,
  workflowFailureNotificationPolicyRequestSchema,
  workflowFailureNotificationPolicyResponseSchema,
} from '../schemas/failure-notification-destinations.js';
import type { z } from 'zod';

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  ConnectionSharingRequest: jsonSchema(connectionSharingRequestSchema, 'input'),
  ConnectionSharing: jsonSchema(connectionSharingResponseSchema, 'output'),
  ConnectionSharingCommand: jsonSchema(
    connectionSharingCommandResponseSchema,
    'output',
  ),
  ConnectionCreateRequest: jsonSchema(connectionCreateRequestSchema, 'input'),
  ConnectionListResponse: jsonSchema(connectionListResponseSchema, 'output'),
  ConnectionResponse: jsonSchema(connectionResponseSchema, 'output'),
  ConnectionUsageResponse: jsonSchema(connectionUsageResponseSchema, 'output'),
  ConnectionRotateSecretRequest: jsonSchema(
    connectionRotateSecretRequestSchema,
    'input',
  ),
  ConnectionTestRequest: jsonSchema(connectionTestRequestSchema, 'input'),
  ConnectionTestResponse: jsonSchema(connectionTestResponseSchema, 'output'),
  OAuth2ClientSettings: jsonSchema(oauth2ClientSettingsSchema, 'output'),
  OAuth2Credential: jsonSchema(oauth2CredentialSchema, 'input'),
  OAuth2Connection: jsonSchema(oauth2ConnectionResponseSchema, 'output'),
  OAuth2ConnectionErrorCode: jsonSchema(
    oauth2ConnectionErrorCodeSchema,
    'output',
  ),
  OAuth2StepFailureCode: jsonSchema(oauth2StepFailureCodeSchema, 'output'),
  OAuth2AuthorizationStart: jsonSchema(
    oauth2AuthorizationStartResponseSchema,
    'output',
  ),
  OAuth2CallbackQuery: jsonSchema(oauth2CallbackQuerySchema, 'input'),
  OAuth2CallbackLanding: jsonSchema(oauth2CallbackLandingSchema, 'output'),
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
  FailureNotificationDestinationTestRequest: jsonSchema(
    failureNotificationDestinationTestRequestSchema,
    'input',
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
  info: { title: 'Pertexo Connections API', version: '1.4.0' },
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
          '503': responseReference('ServiceUnavailable'),
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
    '/v1/workspaces/{workspaceId}/connections/{connectionId}/sharing': {
      get: {
        operationId: 'getConnectionSharing',
        description:
          'Current sharing metadata for workspace owners and admins. No secret material.',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, connectionParameter],
        responses: {
          '200': jsonResponse('Connection sharing', 'ConnectionSharing'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
      post: {
        operationId: 'replaceConnectionSharing',
        description:
          'Replace named Use grants within current workspace capabilities; check the sharing revision and append a metadata audit fact.',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          connectionParameter,
          csrfParameter,
          idempotencyParameter,
        ],
        requestBody: jsonRequest('ConnectionSharingRequest'),
        responses: {
          '200': jsonResponse(
            'Connection sharing changed',
            'ConnectionSharingCommand',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/connections/{connectionId}/usage': {
      get: {
        operationId: 'listConnectionUsage',
        description:
          'Retained published workflow versions using this connection. Requires connection:read and workflow:read in an active workspace.',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          connectionParameter,
          queryParameter('limit', connectionPageLimitSchema),
          queryParameter('after', connectionCursorSchema),
        ],
        responses: {
          '200': jsonResponse(
            'Published connection usage',
            'ConnectionUsageResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
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
    '/v1/workspaces/{workspaceId}/connections/{connectionId}/oauth2/authorization':
      {
        post: {
          operationId: 'startConnectionOAuth2Authorization',
          description:
            'Starts consent for an authorization-code connection and sets its short-lived browser binding cookie, replacing any consent already pending. A client-credentials connection is connected at once. Requires connection:manage in an active workspace.',
          security: [{ cookieSession: [] }],
          parameters: [workspaceParameter, connectionParameter, csrfParameter],
          responses: {
            '200': jsonResponse(
              'Consent to open, or the connected connection',
              'OAuth2AuthorizationStart',
            ),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '409': responseReference('Conflict'),
            '429': responseReference('RateLimited'),
            '503': responseReference('ServiceUnavailable'),
            '500': responseReference('Unexpected'),
          },
        },
      },
    [OAUTH2_CALLBACK_PATH]: {
      get: {
        operationId: 'completeConnectionOAuth2Authorization',
        description:
          'Where a provider returns the browser. The single-use state and its browser binding cookie stand in for the session and CSRF token. Every outcome is a redirect to the web landing page; its query follows OAuth2CallbackLanding. The accepted query is OAuth2CallbackQuery.',
        security: [],
        parameters: [
          requiredQueryParameter('state', oauth2CallbackStateSchema, {
            required: true,
          }),
          requiredQueryParameter('code', oauth2CallbackCodeSchema),
          requiredQueryParameter('error', oauth2CallbackErrorSchema),
        ],
        responses: {
          '303': { description: `Redirect to ${OAUTH2_LANDING_PATH}` },
          '429': responseReference('RateLimited'),
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
            { required: true },
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
          '503': responseReference('ServiceUnavailable'),
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
    '/v1/workspaces/{workspaceId}/failure-notification-destinations/{destinationId}/test':
      {
        post: {
          operationId: 'testFailureNotificationDestination',
          description:
            'Sends one real test message to the reviewed destination version. Replays a completed attempt with the same idempotency key; an uncertain dispatched attempt must not be sent again with a new key.',
          security: [{ cookieSession: [] }],
          parameters: [
            workspaceParameter,
            destinationParameter,
            csrfParameter,
            idempotencyParameter,
          ],
          requestBody: jsonRequest('FailureNotificationDestinationTestRequest'),
          responses: {
            '200': jsonResponse(
              'Alert destination test outcome',
              'ConnectionTestResponse',
            ),
            '400': responseReference('BadRequest'),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '409': responseReference('Conflict'),
            '429': responseReference('RateLimited'),
            '503': responseReference('ServiceUnavailable'),
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
