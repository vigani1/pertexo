import { apiProblemSchema } from '../../errors/api-problem.js';
import {
  workspaceInboxCursorSchema,
  workspaceInboxFilterSchema,
  workspaceInboxLimitSchema,
  workspaceInboxListResponseSchema,
  workspaceInboxReadAllRequestSchema,
  workspaceInboxReadAllResponseSchema,
  workspaceInboxReadRequestSchema,
  workspaceInboxReadResponseSchema,
  workspaceInboxStreamEventSchema,
  workspaceInboxSummaryResponseSchema,
} from '../../schemas/identity/inbox.js';
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
} from '../primitives.js';

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
  WorkspaceInboxReadAllRequest: jsonSchema(
    workspaceInboxReadAllRequestSchema,
    'input',
  ),
  WorkspaceInboxReadAllResponse: jsonSchema(
    workspaceInboxReadAllResponseSchema,
    'output',
  ),
  WorkspaceInboxStreamEvent: jsonSchema(
    workspaceInboxStreamEventSchema,
    'output',
  ),
});
const responses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('CSRF validation failed'),
  NotFound: problemResponse('Inbox or thread unavailable'),
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
const commandProblems = {
  ...readProblems,
  '403': responseReference('Forbidden'),
} as const;

/** ADR 055: failure threads read on demand, with private read state. */
export const workspaceInboxClientContract = Object.freeze({
  schemaVersion: 2,
  routes: Object.freeze([
    { method: 'GET', path: '/v1/workspaces/:workspaceId/notifications' },
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/notifications/summary',
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/notifications/:workflowId/read',
      requiredHeaders: ['X-CSRF-Token'],
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/notifications/read-all',
      requiredHeaders: ['X-CSRF-Token'],
    },
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/notifications/events',
      events: ['inbox.ready', 'inbox.changed'],
    },
  ]),
});
export const workspaceInboxOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Workspace Inbox API', version: '2.0.0' },
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
            'Failing workflows, newest failure first',
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
            'Unread thread count',
            'WorkspaceInboxSummaryResponse',
          ),
          ...readProblems,
        },
      },
    },
    '/v1/workspaces/{workspaceId}/notifications/{workflowId}/read': {
      post: {
        operationId: 'markWorkspaceInboxThreadRead',
        security,
        parameters: [
          workspace,
          simpleUuidPathParameter('workflowId'),
          csrfHeaderParameter('X-CSRF-Token'),
        ],
        requestBody: jsonRequest('WorkspaceInboxReadRequest'),
        responses: {
          '200': jsonResponse(
            'Monotonic, private read of the seen revision',
            'WorkspaceInboxReadResponse',
          ),
          ...commandProblems,
        },
      },
    },
    '/v1/workspaces/{workspaceId}/notifications/read-all': {
      post: {
        operationId: 'markWorkspaceInboxRead',
        security,
        parameters: [workspace, csrfHeaderParameter('X-CSRF-Token')],
        requestBody: jsonRequest('WorkspaceInboxReadAllRequest'),
        responses: {
          '200': jsonResponse(
            'Threads at or below the seen revision are read',
            'WorkspaceInboxReadAllResponse',
          ),
          ...commandProblems,
        },
      },
    },
    '/v1/workspaces/{workspaceId}/notifications/events': {
      get: {
        operationId: 'streamWorkspaceInboxHints',
        security,
        parameters: [workspace],
        responses: {
          '200': {
            description:
              'Server-sent `inbox.ready` and `inbox.changed` hints whose data is a WorkspaceInboxStreamEvent',
            content: {
              'text/event-stream': {
                schema: {
                  $ref: '#/components/schemas/WorkspaceInboxStreamEvent',
                },
              },
            },
          },
          ...readProblems,
        },
      },
    },
  },
});
