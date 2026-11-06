import { z } from 'zod';

import {
  failureNotificationDestinationAppendVersionRequestSchema,
  failureNotificationDestinationCreateRequestSchema,
  failureNotificationDestinationListResponseSchema,
  failureNotificationDestinationResponseSchema,
  failureNotificationDestinationStatusRequestSchema,
  failureNotificationDestinationTestRequestSchema,
  workflowFailureNotificationPolicyRequestSchema,
  workflowFailureNotificationPolicyResponseSchema,
} from '../../schemas/failure-notification-destinations.js';
import { defineRoute, named } from '../define.js';
import { editingWorkflow, managing, problem, readingAlerts } from './access.js';
import { connectionTestResponse } from './management.js';

const ROOT = '/v1/workspaces/{workspaceId}/failure-notification-destinations';
const ONE = `${ROOT}/{destinationId}` as const;
const POLICY =
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/failure-notification-policy';
const workspace = z.object({ workspaceId: z.uuid() }).strict();
const destinationParams = workspace.extend({ destinationId: z.uuid() });
const workflowParams = workspace.extend({ workflowId: z.uuid() });
const destination = named(
  'FailureNotificationDestinationResponse',
  failureNotificationDestinationResponseSchema,
);
const commandProblems = problem('400', '401', '403', '404', '409', '500');

export const failureNotificationRoutes = {
  list: defineRoute({
    operationId: 'listFailureNotificationDestinations',
    query: z.object({ afterId: z.uuid().optional() }).strict(),
    method: 'get',
    path: ROOT,
    params: workspace,
    access: readingAlerts,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Failure notification destinations',
      body: named(
        'FailureNotificationDestinationListResponse',
        failureNotificationDestinationListResponseSchema,
      ),
    },
    problems: problem('400', '401', '403', '404', '503', '500'),
  }),
  create: defineRoute({
    operationId: 'createFailureNotificationDestination',
    method: 'post',
    path: ROOT,
    params: workspace,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named(
      'FailureNotificationDestinationCreateRequest',
      failureNotificationDestinationCreateRequestSchema,
    ),
    success: {
      status: 201,
      description: 'Failure notification destination created',
      body: destination,
    },
    problems: commandProblems,
  }),
  get: defineRoute({
    operationId: 'getFailureNotificationDestination',
    method: 'get',
    path: ONE,
    params: destinationParams,
    access: readingAlerts,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Failure notification destination',
      body: destination,
    },
    problems: problem('401', '403', '404', '500'),
  }),
  test: defineRoute({
    operationId: 'testFailureNotificationDestination',
    method: 'post',
    path: `${ONE}/test`,
    params: destinationParams,
    access: managing,
    rateLimit: 'destination_test',
    idempotent: true,
    description:
      'Sends one real test message to the reviewed destination version. Replays a completed attempt with the same idempotency key; an uncertain dispatched attempt must not be sent again with a new key.',
    body: named(
      'FailureNotificationDestinationTestRequest',
      failureNotificationDestinationTestRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Alert destination test outcome',
      body: connectionTestResponse,
    },
    problems: problem('400', '401', '403', '404', '409', '429', '503', '500'),
  }),
  appendVersion: defineRoute({
    operationId: 'appendFailureNotificationDestinationVersion',
    method: 'post',
    path: `${ONE}/versions`,
    params: destinationParams,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named(
      'FailureNotificationDestinationAppendVersionRequest',
      failureNotificationDestinationAppendVersionRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Failure notification destination version appended',
      body: destination,
    },
    problems: commandProblems,
  }),
  setStatus: defineRoute({
    operationId: 'setFailureNotificationDestinationStatus',
    method: 'put',
    path: `${ONE}/status`,
    params: destinationParams,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named(
      'FailureNotificationDestinationStatusRequest',
      failureNotificationDestinationStatusRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Failure notification destination status changed',
      body: destination,
    },
    problems: commandProblems,
  }),
  policy: defineRoute({
    operationId: 'getWorkflowFailureNotificationPolicy',
    method: 'get',
    path: POLICY,
    params: workflowParams,
    access: readingAlerts,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Failure notification policy',
      body: named(
        'WorkflowFailureNotificationPolicyResponse',
        workflowFailureNotificationPolicyResponseSchema,
      ),
    },
    problems: problem('401', '403', '404', '500'),
  }),
  setPolicy: defineRoute({
    operationId: 'setWorkflowFailureNotificationPolicy',
    method: 'put',
    path: POLICY,
    params: workflowParams,
    access: editingWorkflow,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named(
      'WorkflowFailureNotificationPolicyRequest',
      workflowFailureNotificationPolicyRequestSchema,
    ),
    success: {
      status: 204,
      response: { description: 'Failure notification policy set' },
    },
    problems: commandProblems,
  }),
  clearPolicy: defineRoute({
    operationId: 'clearWorkflowFailureNotificationPolicy',
    method: 'delete',
    path: POLICY,
    params: workflowParams,
    access: editingWorkflow,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    success: {
      status: 204,
      response: { description: 'Failure notification policy cleared' },
    },
    problems: commandProblems,
  }),
};
