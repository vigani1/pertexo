export * from './http/workspace-inbox.js';

import { apiProblemSchema } from './errors/api-problem.js';
import {
  workspaceInboxCursorSchema,
  workspaceInboxFilterSchema,
  workspaceInboxLimitSchema,
  workspaceInboxListResponseSchema,
  workspaceInboxReadRequestSchema,
  workspaceInboxReadResponseSchema,
  workspaceInboxSummaryResponseSchema,
} from './http/workspace-inbox.js';
import {
  authenticatedComponents,
  csrfHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  queryParameter,
  responseReference,
  simpleUuidPathParameter,
} from './openapi-primitives.js';

const workspace = simpleUuidPathParameter('workspaceId');
const security = [{ cookieSession: [] }] as const;
const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  WorkspaceInboxListResponse: jsonSchema(
    workspaceInboxListResponseSchema,
    'output',
  ),
  WorkspaceInboxSummaryResponse: jsonSchema(
    workspaceInboxSummaryResponseSchema,
    'output',
  ),
  WorkspaceInboxReadRequest: jsonSchema(
    workspaceInboxReadRequestSchema,
    'input',
  ),
  WorkspaceInboxReadResponse: jsonSchema(
    workspaceInboxReadResponseSchema,
    'output',
  ),
});
const responses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('CSRF validation failed'),
  NotFound: problemResponse('Inbox or entry unavailable'),
  RateLimited: problemResponse('Rate limited'),
  Unexpected: problemResponse('Unexpected server error'),
});
const readProblems = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '404': responseReference('NotFound'),
  '429': responseReference('RateLimited'),
  '500': responseReference('Unexpected'),
} as const;

/** Declared interface only: handlers and feature exposure ship separately. */
export const workspaceInboxClientContract = Object.freeze({
  schemaVersion: 1,
  routes: Object.freeze([
    { method: 'GET', path: '/v1/workspaces/:workspaceId/notifications' },
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/notifications/summary',
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/notifications/:notificationId/read',
      requiredHeaders: ['X-CSRF-Token'],
    },
  ]),
});
export const workspaceInboxOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Workspace Inbox API', version: '1.0.0' },
  components: authenticatedComponents(schemas, responses),
  paths: {
    '/v1/workspaces/{workspaceId}/notifications': {
      get: {
        operationId: 'listWorkspaceInbox',
        security,
        parameters: [
          workspace,
          queryParameter('filter', workspaceInboxFilterSchema),
          queryParameter('limit', workspaceInboxLimitSchema),
          queryParameter('after', workspaceInboxCursorSchema),
        ],
        responses: {
          '200': jsonResponse(
            'Private unexpired notices',
            'WorkspaceInboxListResponse',
          ),
          ...readProblems,
        },
      },
    },
    '/v1/workspaces/{workspaceId}/notifications/summary': {
      get: {
        operationId: 'getWorkspaceInboxSummary',
        security,
        parameters: [workspace],
        responses: {
          '200': jsonResponse(
            'Private unexpired unread count',
            'WorkspaceInboxSummaryResponse',
          ),
          ...readProblems,
        },
      },
    },
    '/v1/workspaces/{workspaceId}/notifications/{notificationId}/read': {
      post: {
        operationId: 'markWorkspaceInboxEntryRead',
        security,
        parameters: [
          workspace,
          simpleUuidPathParameter('notificationId'),
          csrfHeaderParameter('X-CSRF-Token'),
        ],
        requestBody: jsonRequest('WorkspaceInboxReadRequest'),
        responses: {
          '200': jsonResponse(
            'Monotonic read acknowledgment',
            'WorkspaceInboxReadResponse',
          ),
          ...readProblems,
          '403': responseReference('Forbidden'),
        },
      },
    },
  },
});
