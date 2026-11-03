import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { z } from 'zod';

import {
  connectionCreateRequestSchema,
  connectionIdParamSchema,
  connectionListQuerySchema,
  connectionListResponseSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
  connectionSharingCommandResponseSchema,
  connectionSharingRequestSchema,
  connectionSharingResponseSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  connectionUsageResponseSchema,
  slackChannelLookupQuerySchema,
  slackChannelLookupResponseSchema,
} from '../../schemas/connections.js';
import { oauth2AuthorizationStartResponseSchema } from '../../schemas/oauth2-connections.js';
import { defineRoute, named } from '../define.js';
import { managing, problem, readingSession, using } from './access.js';

const ROOT = '/v1/workspaces/{workspaceId}/connections';
const ONE = `${ROOT}/{connectionId}` as const;
const workspace = z.object({ workspaceId: z.uuid() }).strict();
const connection = named('ConnectionResponse', connectionResponseSchema);
export const connectionTestResponse = named(
  'ConnectionTestResponse',
  connectionTestResponseSchema,
);

export const connectionRoutes = {
  list: defineRoute({
    operationId: 'listConnections',
    method: 'get',
    path: ROOT,
    params: workspace,
    query: connectionListQuerySchema,
    access: {
      auth: 'session_or_token',
      capabilities: [
        {
          name: 'connection:read',
          statuses: BROWSABLE_WORKSPACE_STATUSES,
          disclosure: 'not_found',
        },
      ],
    },
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Connections',
      body: named('ConnectionListResponse', connectionListResponseSchema),
    },
    problems: problem('400', '401', '403', '404', '503', '500'),
  }),
  create: defineRoute({
    operationId: 'createConnection',
    method: 'post',
    path: ROOT,
    params: workspace,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named('ConnectionCreateRequest', connectionCreateRequestSchema),
    success: {
      status: 201,
      description: 'Connection created',
      body: connection,
    },
    problems: problem('400', '401', '403', '409', '503', '500'),
  }),
  sharing: defineRoute({
    operationId: 'getConnectionSharing',
    method: 'get',
    path: `${ONE}/sharing`,
    params: connectionIdParamSchema,
    access: managing,
    rateLimit: 'authenticated_read',
    description:
      'Current sharing metadata for workspace owners and admins. No secret material.',
    success: {
      status: 200,
      description: 'Connection sharing',
      body: named('ConnectionSharing', connectionSharingResponseSchema),
    },
    problems: problem('400', '401', '403', '404', '429', '500'),
  }),
  replaceSharing: defineRoute({
    operationId: 'replaceConnectionSharing',
    method: 'post',
    path: `${ONE}/sharing`,
    params: connectionIdParamSchema,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    description:
      'Replace named Use grants within current workspace capabilities; check the sharing revision and append a metadata audit fact.',
    body: named('ConnectionSharingRequest', connectionSharingRequestSchema),
    success: {
      status: 200,
      description: 'Connection sharing changed',
      body: named(
        'ConnectionSharingCommand',
        connectionSharingCommandResponseSchema,
      ),
    },
    problems: problem('400', '401', '403', '404', '409', '429', '500'),
  }),
  usage: defineRoute({
    operationId: 'listConnectionUsage',
    method: 'get',
    path: `${ONE}/usage`,
    params: connectionIdParamSchema,
    query: connectionListQuerySchema,
    access: readingSession,
    rateLimit: 'authenticated_read',
    description:
      'Retained published workflow versions using this connection. Requires connection:read and workflow:read in an active workspace.',
    success: {
      status: 200,
      description: 'Published connection usage',
      body: named('ConnectionUsageResponse', connectionUsageResponseSchema),
    },
    problems: problem('400', '401', '403', '404', '500'),
  }),
  rotateSecret: defineRoute({
    operationId: 'rotateConnectionSecret',
    method: 'put',
    path: `${ONE}/secret`,
    params: connectionIdParamSchema,
    access: managing,
    rateLimit: 'connection_mutation',
    idempotent: true,
    body: named(
      'ConnectionRotateSecretRequest',
      connectionRotateSecretRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Connection secret rotated',
      body: connection,
    },
    problems: problem('400', '401', '403', '404', '409', '503', '500'),
  }),
  get: defineRoute({
    operationId: 'getConnection',
    method: 'get',
    path: ONE,
    params: connectionIdParamSchema,
    access: {
      auth: 'session_or_token',
      capabilities: [
        {
          name: 'connection:read',
          statuses: BROWSABLE_WORKSPACE_STATUSES,
          disclosure: 'not_found',
        },
      ],
    },
    rateLimit: 'authenticated_read',
    success: { status: 200, description: 'Connection', body: connection },
    problems: problem('400', '401', '403', '404', '500'),
  }),
  revoke: defineRoute({
    operationId: 'revokeConnection',
    method: 'delete',
    path: ONE,
    params: connectionIdParamSchema,
    access: managing,
    rateLimit: 'connection_mutation',
    success: {
      status: 200,
      description: 'Connection revoked',
      body: connection,
    },
    problems: problem('400', '401', '403', '404', '500'),
  }),
  test: defineRoute({
    operationId: 'testConnection',
    method: 'post',
    path: `${ONE}/test`,
    params: connectionIdParamSchema,
    access: using,
    rateLimit: 'provider_test',
    idempotent: true,
    body: named('ConnectionTestRequest', connectionTestRequestSchema),
    success: {
      status: 200,
      description: 'Connection test completed',
      body: connectionTestResponse,
    },
    problems: problem('400', '401', '403', '404', '409', '503', '500'),
  }),
  startOAuth2: defineRoute({
    operationId: 'startConnectionOAuth2Authorization',
    method: 'post',
    path: `${ONE}/oauth2/authorization`,
    params: connectionIdParamSchema,
    access: managing,
    rateLimit: 'provider_test',
    description:
      'Starts consent for an authorization-code connection and sets its short-lived browser binding cookie, replacing any consent already pending. A client-credentials connection is connected at once. Requires connection:manage in an active workspace.',
    success: {
      status: 200,
      description: 'Consent to open, or the connected connection',
      body: named(
        'OAuth2AuthorizationStart',
        oauth2AuthorizationStartResponseSchema,
      ),
    },
    problems: problem('401', '403', '404', '409', '429', '503', '500'),
  }),
  slackChannels: defineRoute({
    operationId: 'lookupSlackChannels',
    method: 'get',
    path: `${ONE}/slack/channels`,
    params: connectionIdParamSchema,
    query: slackChannelLookupQuerySchema,
    access: using,
    rateLimit: 'provider_test',
    description:
      'Resolves up to ten Slack channel IDs to names with the connection bot token (ADR 046). Channels that cannot be resolved are returned as unresolved with a reason.',
    success: {
      status: 200,
      description: 'Channel names, in request order',
      body: named(
        'SlackChannelLookupResponse',
        slackChannelLookupResponseSchema,
      ),
    },
    problems: problem('400', '401', '403', '404', '429', '503', '500'),
  }),
};
