export * from './http/schedules.js';

import { apiProblemSchema } from './errors/api-problem.js';
import {
  scheduleFireTimeCountSchema,
  scheduleFireTimesResponseSchema,
  scheduleManagementCommandRequestSchema,
  scheduleManagementCommandResponseSchema,
  scheduleOccurrenceCursorSchema,
  scheduleOccurrenceListResponseSchema,
  scheduleOccurrencePageLimitSchema,
  schedulePreviewRequestSchema,
  scheduleTriggerListResponseSchema,
} from './http/schedules.js';
import {
  authenticatedComponents,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  queryParameter,
  responseReference,
  simpleUuidPathParameter as pathParameter,
} from './openapi-primitives.js';

const workspaceParameter = pathParameter('workspaceId');
const workflowParameter = pathParameter('workflowId');
const triggerParameter = pathParameter('triggerId');
const idempotencyParameter = idempotencyHeaderParameter();
const csrfParameter = csrfHeaderParameter('X-CSRF-Token');
const commandParameters = [
  workspaceParameter,
  workflowParameter,
  triggerParameter,
  idempotencyParameter,
  csrfParameter,
] as const;
const security = [{ cookieSession: [] }] as const;

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  ScheduleManagementCommandRequest: jsonSchema(
    scheduleManagementCommandRequestSchema,
    'input',
  ),
  ScheduleManagementCommandResponse: jsonSchema(
    scheduleManagementCommandResponseSchema,
    'output',
  ),
  ScheduleTriggerListResponse: jsonSchema(
    scheduleTriggerListResponseSchema,
    'output',
  ),
  ScheduleOccurrenceListResponse: jsonSchema(
    scheduleOccurrenceListResponseSchema,
    'output',
  ),
  ScheduleFireTimesResponse: jsonSchema(
    scheduleFireTimesResponseSchema,
    'output',
  ),
  SchedulePreviewRequest: jsonSchema(schedulePreviewRequestSchema, 'input'),
});
const responses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  PreconditionRequired: problemResponse('Idempotency key required'),
  RateLimited: problemResponse('Rate limited'),
  Unexpected: problemResponse('Unexpected server error'),
});

export const schedulesClientContract = Object.freeze({
  schemaVersion: 1,
  routes: Object.freeze([
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/schedules',
    },
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/schedule/occurrences',
    },
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/schedule/next-runs',
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/schedules/preview',
      requiredHeaders: ['X-CSRF-Token'],
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/schedule/enable',
      requiredHeaders: ['Idempotency-Key', 'X-CSRF-Token'],
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/schedule/disable',
      requiredHeaders: ['Idempotency-Key', 'X-CSRF-Token'],
    },
  ]),
});

const command = {
  post: {
    security,
    parameters: commandParameters,
    requestBody: jsonRequest('ScheduleManagementCommandRequest'),
    responses: {
      '200': jsonResponse(
        'Schedule trigger command completed',
        'ScheduleManagementCommandResponse',
      ),
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': responseReference('Conflict'),
      '428': responseReference('PreconditionRequired'),
      '500': responseReference('Unexpected'),
    },
  },
} as const;

const readProblems = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '429': responseReference('RateLimited'),
  '500': responseReference('Unexpected'),
} as const;

export const schedulesOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Schedules API', version: '1.0.0' },
  components: authenticatedComponents(schemas, responses),
  paths: {
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/schedules': {
      get: {
        operationId: 'listScheduleTriggers',
        security,
        parameters: [workspaceParameter, workflowParameter],
        responses: {
          '200': jsonResponse(
            'Published schedule trigger health',
            'ScheduleTriggerListResponse',
          ),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/schedule/occurrences':
      {
        get: {
          operationId: 'listScheduleOccurrences',
          security,
          parameters: [
            workspaceParameter,
            workflowParameter,
            triggerParameter,
            queryParameter('limit', scheduleOccurrencePageLimitSchema),
            queryParameter('after', scheduleOccurrenceCursorSchema),
          ],
          responses: {
            '200': jsonResponse(
              'Retained occurrence metadata, newest first',
              'ScheduleOccurrenceListResponse',
            ),
            ...readProblems,
          },
        },
      },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/schedule/next-runs':
      {
        get: {
          operationId: 'listScheduleNextRuns',
          security,
          parameters: [
            workspaceParameter,
            workflowParameter,
            triggerParameter,
            queryParameter('count', scheduleFireTimeCountSchema),
          ],
          responses: {
            '200': jsonResponse(
              'Upcoming fire times of a published schedule',
              'ScheduleFireTimesResponse',
            ),
            ...readProblems,
          },
        },
      },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/schedules/preview':
      {
        post: {
          operationId: 'previewScheduleRuns',
          security,
          parameters: [workspaceParameter, workflowParameter, csrfParameter],
          requestBody: jsonRequest('SchedulePreviewRequest'),
          responses: {
            '200': jsonResponse(
              'Fire times an unsaved schedule rule would have if published now',
              'ScheduleFireTimesResponse',
            ),
            ...readProblems,
          },
        },
      },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/schedule/enable':
      command,
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/schedule/disable':
      command,
  },
});
