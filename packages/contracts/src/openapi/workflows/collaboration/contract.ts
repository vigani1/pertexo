import { z } from 'zod';
import * as comments from '../../../schemas/workflows/collaboration/comments.js';
import * as presence from '../../../schemas/workflows/collaboration/presence.js';
import {
  workspacePeoplePageSchema,
  workspacePeopleQuerySchema,
} from '../../../schemas/identity/people.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  queryParameter,
  responseReference,
  uuidPathParameter,
} from '../../primitives.js';
export function collaborationContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    WorkflowCommentList: project(
      'WorkflowCommentList',
      comments.workflowCommentListSchema,
      'output',
    ),
    WorkflowCommentDetail: project(
      'WorkflowCommentDetail',
      comments.workflowCommentDetailSchema,
      'output',
    ),
    WorkflowCommentCreate: project(
      'WorkflowCommentCreate',
      comments.workflowCommentCreateSchema,
      'input',
    ),
    WorkflowCommentBody: project(
      'WorkflowCommentBody',
      comments.workflowCommentBodySchema,
      'input',
    ),
    WorkflowCommentEdit: project(
      'WorkflowCommentEdit',
      comments.workflowCommentEditSchema,
      'input',
    ),
    WorkflowCommentDelete: project(
      'WorkflowCommentDelete',
      comments.workflowCommentDeleteSchema,
      'input',
    ),
    WorkflowCommentStatus: project(
      'WorkflowCommentStatus',
      comments.workflowCommentStatusSchema,
      'input',
    ),
    WorkflowCommentCommandResult: project(
      'WorkflowCommentCommandResult',
      comments.workflowCommentCommandResultSchema,
      'output',
    ),
    WorkflowPresence: project(
      'WorkflowPresence',
      presence.workflowPresenceSchema,
      'output',
    ),
    WorkflowPresenceHeartbeat: project(
      'WorkflowPresenceHeartbeat',
      presence.workflowPresenceHeartbeatSchema,
      'input',
    ),
    WorkflowPresenceHeartbeatResult: project(
      'WorkflowPresenceHeartbeatResult',
      presence.workflowPresenceHeartbeatResultSchema,
      'output',
    ),
    WorkspacePeoplePage: project(
      'WorkspacePeoplePage',
      workspacePeoplePageSchema,
      'output',
    ),
  };
}
function operation(
  operationId: string,
  response: string | null,
  options: {
    ids?: readonly string[];
    request?: string;
    query?: readonly ReturnType<typeof queryParameter>[];
    heartbeat?: boolean;
    status?: number;
  } = {},
) {
  return {
    operationId,
    security: [{ cookieSession: [] }],
    parameters: [
      uuidPathParameter('workspaceId'),
      uuidPathParameter('workflowId'),
      ...(options.ids ?? []).map((id) => uuidPathParameter(id)),
      ...(options.query ?? []),
      ...(options.request === undefined && !options.heartbeat
        ? []
        : [
            csrfHeaderParameter(),
            ...(options.heartbeat ? [] : [idempotencyHeaderParameter()]),
          ]),
    ],
    ...(options.request === undefined
      ? {}
      : { requestBody: jsonRequest(options.request) }),
    responses: {
      [String(options.status ?? 200)]:
        response === null
          ? { description: 'Presence released' }
          : jsonResponse('Workflow collaboration', response),
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': responseReference('Conflict'),
      '429': responseReference('RateLimited'),
      '500': responseReference('Unexpected'),
    },
  };
}
const base = '/v1/workspaces/{workspaceId}/workflows/{workflowId}';
export const collaborationContractPaths = {
  [base + '/comments']: {
    get: operation('listWorkflowComments', 'WorkflowCommentList', {
      query: [
        queryParameter('after', z.uuid()),
        queryParameter('limit', z.number().int().min(1).max(20)),
        queryParameter('status', z.enum(['all', 'open', 'resolved'])),
        queryParameter('scope', z.enum(['all', 'workflow', 'step'])),
        queryParameter('stepId', z.string().min(1).max(128)),
      ],
    }),
    post: operation('createWorkflowComment', 'WorkflowCommentCommandResult', {
      request: 'WorkflowCommentCreate',
      status: 201,
    }),
  },
  [base + '/comments/people']: {
    get: operation('listDiscussionPeople', 'WorkspacePeoplePage', {
      query: [
        queryParameter('q', workspacePeopleQuerySchema.shape.q),
        queryParameter('after', z.uuid()),
      ],
    }),
  },
  [base + '/comments/{threadId}']: {
    get: operation('getWorkflowCommentThread', 'WorkflowCommentDetail', {
      ids: ['threadId'],
      query: [
        queryParameter('before', z.uuid()),
        queryParameter('anchor', z.uuid()),
        queryParameter('limit', z.number().int().min(1).max(20)),
      ],
    }),
  },
  [base + '/comments/{threadId}/replies']: {
    post: operation('replyWorkflowComment', 'WorkflowCommentCommandResult', {
      ids: ['threadId'],
      request: 'WorkflowCommentBody',
      status: 201,
    }),
  },
  [base + '/comments/{threadId}/comments/{commentId}']: {
    put: operation('editWorkflowComment', 'WorkflowCommentCommandResult', {
      ids: ['threadId', 'commentId'],
      request: 'WorkflowCommentEdit',
    }),
    delete: operation('deleteWorkflowComment', 'WorkflowCommentCommandResult', {
      ids: ['threadId', 'commentId'],
      request: 'WorkflowCommentDelete',
    }),
  },
  [base + '/comments/{threadId}/status']: {
    put: operation('setWorkflowCommentStatus', 'WorkflowCommentCommandResult', {
      ids: ['threadId'],
      request: 'WorkflowCommentStatus',
    }),
  },
  [base + '/presence']: {
    get: operation('getWorkflowPresence', 'WorkflowPresence', {
      query: [queryParameter('tabId', z.uuid(), true)],
    }),
  },
  [base + '/presence/{tabId}']: {
    put: operation(
      'heartbeatWorkflowPresence',
      'WorkflowPresenceHeartbeatResult',
      { ids: ['tabId'], request: 'WorkflowPresenceHeartbeat', heartbeat: true },
    ),
    delete: operation('leaveWorkflowPresence', null, {
      ids: ['tabId'],
      heartbeat: true,
      status: 204,
    }),
  },
};
