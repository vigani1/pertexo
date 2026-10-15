import {
  approvalAudiencePageSchema,
  approvalAudienceQuerySchema,
  pendingTaskDecisionRequestSchema,
  pendingTaskSubmitRequestSchema,
  pendingTaskDecisionResponseSchema,
  pendingTaskListQuerySchema,
  pendingTaskListResponseSchema,
  pendingTaskResponseSchema,
  pendingTaskSummarySchema,
  pendingTaskDetailSchema,
} from '../../schemas/execution/pending-tasks.js';
import {
  jsonSchema,
  jsonResponse,
  jsonRequest,
  uuidPathParameter,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  queryParameter,
  responseReference,
} from '../primitives.js';
export const pendingTaskSchemas = {
  PendingTaskSummary: jsonSchema(pendingTaskSummarySchema, 'output'),
  PendingTaskDetail: jsonSchema(pendingTaskDetailSchema, 'output'),
  PendingTaskResponse: jsonSchema(pendingTaskResponseSchema, 'output'),
  PendingTaskListResponse: jsonSchema(pendingTaskListResponseSchema, 'output'),
  PendingTaskDecisionRequest: jsonSchema(
    pendingTaskDecisionRequestSchema,
    'input',
  ),
  PendingTaskDecisionResponse: jsonSchema(
    pendingTaskDecisionResponseSchema,
    'output',
  ),
  PendingTaskSubmitRequest: jsonSchema(pendingTaskSubmitRequestSchema, 'input'),
  ApprovalAudiencePage: jsonSchema(approvalAudiencePageSchema, 'output'),
};
const workspace = uuidPathParameter('workspaceId', 'Workspace identifier');
const task = uuidPathParameter('taskId', 'Pending task identifier');
const security = [{ cookieSession: [] }];
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '500': responseReference('Unexpected'),
};
export const pendingTaskPaths = {
  '/v1/workspaces/{workspaceId}/pending-tasks/{taskId}/submit': {
    post: {
      operationId: 'submitPendingTask',
      security,
      parameters: [
        workspace,
        task,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('PendingTaskSubmitRequest'),
      responses: {
        '200': jsonResponse('Recorded input', 'PendingTaskDecisionResponse'),
        ...errors,
        '409': responseReference('Conflict'),
      },
    },
  },
  '/v1/workspaces/{workspaceId}/pending-tasks': {
    get: {
      operationId: 'listPendingTasks',
      security,
      parameters: [
        workspace,
        ...Object.entries(pendingTaskListQuerySchema.shape).map(
          ([name, schema]) => queryParameter(name, schema),
        ),
      ],
      responses: {
        '200': jsonResponse(
          'Durable tasks visible to this member',
          'PendingTaskListResponse',
        ),
        ...errors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/pending-tasks/audience': {
    get: {
      operationId: 'listApprovalAudience',
      security,
      parameters: [
        workspace,
        ...Object.entries(approvalAudienceQuerySchema.shape).map(
          ([name, schema]) => queryParameter(name, schema),
        ),
      ],
      responses: {
        '200': jsonResponse(
          'Active member identities for approval setup',
          'ApprovalAudiencePage',
        ),
        ...errors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/pending-tasks/{taskId}': {
    get: {
      operationId: 'getPendingTask',
      security,
      parameters: [workspace, task],
      responses: {
        '200': jsonResponse(
          'Task details and current decision eligibility',
          'PendingTaskResponse',
        ),
        ...errors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/pending-tasks/{taskId}/decide': {
    post: {
      operationId: 'decidePendingTask',
      security,
      parameters: [
        workspace,
        task,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('PendingTaskDecisionRequest'),
      responses: {
        '200': jsonResponse(
          'One recorded decision, or its idempotent replay',
          'PendingTaskDecisionResponse',
        ),
        '409': responseReference('Conflict'),
        ...errors,
      },
    },
  },
};
