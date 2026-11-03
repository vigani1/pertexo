import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { webhookAuthenticationSchema } from '@pertexo/workflow-model';
import { z } from 'zod';

import { responseReference } from '../../openapi/primitives.js';
import {
  webhookDeliveryListQuerySchema,
  webhookDeliveryListResponseSchema,
  webhookManagementCommandResponseSchema,
  webhookRotateSecretRequestSchema,
  webhookTestEventSnapshotSchema,
  webhookTestEventStartSchema,
  webhookTestEventStartedSchema,
  webhookTriggerListResponseSchema,
} from '../../schemas/triggers/webhooks.js';
import {
  defineRoute,
  named,
  type NamedSchema,
  type RouteAccess,
} from '../define.js';

const TRIGGERS = '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers';
const WEBHOOK = `${TRIGGERS}/{triggerId}/webhook` as const;
const TEST_EVENTS =
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/nodes/{nodeId}/webhook-test-events';
const workflow = z.object({ workspaceId: z.uuid(), workflowId: z.uuid() });
const trigger = workflow.extend({ triggerId: z.uuid() });
const node = workflow.extend({ nodeId: z.string().min(1).max(64) });
const testEvent = node.extend({ id: z.uuid() });

const reading: RouteAccess = {
  auth: 'session',
  capabilities: [
    {
      name: 'workflow:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const updating: RouteAccess = {
  auth: 'session',
  capabilities: [
    {
      name: 'workflow:update',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const commandProblems = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '500': responseReference('Unexpected'),
};
const testProblems = {
  ...commandProblems,
  '429': responseReference('RateLimited'),
};
/** A route that takes no settings says so, rather than ignoring what it was sent. */
const noSettings = named(
  'WebhookNoSettings',
  z.object({}).strict().default({}),
);
const command = <Body extends z.ZodType>(
  operationId: string,
  path: `/${string}`,
  body: NamedSchema<Body>,
) =>
  defineRoute({
    operationId,
    method: 'post',
    path,
    params: trigger,
    access: updating,
    rateLimit: 'trigger_mutation',
    idempotent: true,
    body,
    success: {
      status: 200,
      description: 'Webhook trigger command completed',
      body: named(
        'WebhookManagementCommandResponse',
        webhookManagementCommandResponseSchema,
      ),
    },
    problems: commandProblems,
  });

export const webhookRoutes = {
  list: defineRoute({
    operationId: 'listWebhookTriggers',
    method: 'get',
    path: TRIGGERS,
    params: workflow,
    access: reading,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Published trigger health',
      body: named(
        'WebhookTriggerListResponse',
        webhookTriggerListResponseSchema,
      ),
    },
    problems: {
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '500': responseReference('Unexpected'),
    },
  }),
  deliveries: defineRoute({
    operationId: 'listWebhookDeliveries',
    method: 'get',
    path: `${WEBHOOK}/deliveries`,
    params: trigger,
    query: webhookDeliveryListQuerySchema,
    access: reading,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Retained delivery metadata, newest first',
      body: named(
        'WebhookDeliveryListResponse',
        webhookDeliveryListResponseSchema,
      ),
    },
    problems: {
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '429': responseReference('RateLimited'),
      '500': responseReference('Unexpected'),
    },
  }),
  provision: command(
    'provisionWebhookEndpoint',
    `${WEBHOOK}/provision`,
    noSettings,
  ),
  configureAuthentication: command(
    'configureWebhookAuthentication',
    `${WEBHOOK}/authentication`,
    named('WebhookAuthentication', webhookAuthenticationSchema),
  ),
  rotateEndpoint: command(
    'rotateWebhookEndpoint',
    `${WEBHOOK}/rotate-endpoint`,
    noSettings,
  ),
  rotateSecret: command(
    'rotateWebhookSecret',
    `${WEBHOOK}/rotate-secret`,
    named('WebhookRotateSecretRequest', webhookRotateSecretRequestSchema),
  ),
  startTest: defineRoute({
    operationId: 'listenForWebhookTestEvent',
    method: 'post',
    path: TEST_EVENTS,
    params: node,
    access: updating,
    rateLimit: 'trigger_mutation',
    cacheControl: 'no-store',
    body: named('WebhookTestEventStart', webhookTestEventStartSchema),
    success: {
      status: 200,
      description: 'Temporary test URL and credentials, no-store',
      body: named('WebhookTestEventStarted', webhookTestEventStartedSchema),
    },
    problems: testProblems,
  }),
  readTest: defineRoute({
    operationId: 'readWebhookTestEvent',
    method: 'get',
    path: `${TEST_EVENTS}/{id}`,
    params: testEvent,
    access: updating,
    rateLimit: 'authenticated_read',
    cacheControl: 'no-store',
    success: {
      status: 200,
      description: 'Private temporary test capture, no-store',
      body: named('WebhookTestEventSnapshot', webhookTestEventSnapshotSchema, {
        projected: true,
      }),
    },
    problems: testProblems,
  }),
  stopTest: defineRoute({
    operationId: 'stopWebhookTestEvent',
    method: 'delete',
    path: `${TEST_EVENTS}/{id}`,
    params: testEvent,
    access: updating,
    rateLimit: 'trigger_mutation',
    success: {
      status: 204,
      response: { description: 'Listener and capture removed' },
    },
    problems: testProblems,
  }),
};
