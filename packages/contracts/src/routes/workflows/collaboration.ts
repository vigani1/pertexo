import { z } from 'zod';
import * as people from '../../schemas/identity/people.js';
import { workflowIdParamSchema } from '../../schemas/workflows/authoring.js';
import * as comments from '../../schemas/workflows/collaboration/comments.js';
import * as presence from '../../schemas/workflows/collaboration/presence.js';
import { projected, reading, session } from './access.js';
const participating = session('workflow:read');
const threadParams = workflowIdParamSchema
  .extend({ threadId: z.uuid() })
  .strict();
const commentParams = threadParams.extend({ commentId: z.uuid() }).strict();
const presenceParams = workflowIdParamSchema
  .extend({ tabId: z.uuid() })
  .strict();

import { responseReference } from '../../openapi/primitives.js';
import { defineRoute } from '../define.js';
const sharedProblems1 = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '429': responseReference('RateLimited'),
  '500': responseReference('Unexpected'),
};
export const collaborationRoutes = {
  list: defineRoute({
    operationId: 'listWorkflowComments',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/comments',
    params: workflowIdParamSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    query: comments.workflowCommentListQuerySchema,
    success: {
      status: 200,
      description: 'Workflow collaboration',
      body: projected(
        'WorkflowCommentList',
        comments.workflowCommentListSchema,
      ),
    },
    problems: sharedProblems1,
  }),
  people: defineRoute({
    operationId: 'listDiscussionPeople',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/comments/people',
    params: workflowIdParamSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    query: people.workspacePeopleQuerySchema,
    success: {
      status: 200,
      description: 'Workflow collaboration',
      body: projected('WorkspacePeoplePage', people.workspacePeoplePageSchema),
    },
    problems: sharedProblems1,
  }),
  read: defineRoute({
    operationId: 'getWorkflowCommentThread',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/comments/{threadId}',
    params: threadParams,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    query: comments.workflowCommentDetailQuerySchema,
    success: {
      status: 200,
      description: 'Workflow collaboration',
      body: projected(
        'WorkflowCommentDetail',
        comments.workflowCommentDetailSchema,
      ),
    },
    problems: sharedProblems1,
  }),
  create: defineRoute({
    operationId: 'createWorkflowComment',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/comments',
    params: workflowIdParamSchema,
    access: participating,
    rateLimit: 'ordinary_mutation',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowCommentCreate',
      comments.workflowCommentCreateSchema,
    ),
    idempotent: true,
    success: {
      status: 201,
      description: 'Workflow collaboration',
      body: projected(
        'WorkflowCommentCommandResult',
        comments.workflowCommentCommandResultSchema,
      ),
    },
    problems: sharedProblems1,
  }),
  reply: defineRoute({
    operationId: 'replyWorkflowComment',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/comments/{threadId}/replies',
    params: threadParams,
    access: participating,
    rateLimit: 'ordinary_mutation',
    cacheControl: 'private, no-store',
    body: projected('WorkflowCommentBody', comments.workflowCommentBodySchema),
    idempotent: true,
    success: {
      status: 201,
      description: 'Workflow collaboration',
      body: projected(
        'WorkflowCommentCommandResult',
        comments.workflowCommentCommandResultSchema,
      ),
    },
    problems: sharedProblems1,
  }),
  edit: defineRoute({
    operationId: 'editWorkflowComment',
    method: 'put',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/comments/{threadId}/comments/{commentId}',
    params: commentParams,
    access: participating,
    rateLimit: 'ordinary_mutation',
    cacheControl: 'private, no-store',
    body: projected('WorkflowCommentEdit', comments.workflowCommentEditSchema),
    idempotent: true,
    success: {
      status: 200,
      description: 'Workflow collaboration',
      body: projected(
        'WorkflowCommentCommandResult',
        comments.workflowCommentCommandResultSchema,
      ),
    },
    problems: sharedProblems1,
  }),
  remove: defineRoute({
    operationId: 'deleteWorkflowComment',
    method: 'delete',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/comments/{threadId}/comments/{commentId}',
    params: commentParams,
    access: participating,
    rateLimit: 'ordinary_mutation',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowCommentDelete',
      comments.workflowCommentDeleteSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description: 'Workflow collaboration',
      body: projected(
        'WorkflowCommentCommandResult',
        comments.workflowCommentCommandResultSchema,
      ),
    },
    problems: sharedProblems1,
  }),
  setStatus: defineRoute({
    operationId: 'setWorkflowCommentStatus',
    method: 'put',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/comments/{threadId}/status',
    params: threadParams,
    access: participating,
    rateLimit: 'ordinary_mutation',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowCommentStatus',
      comments.workflowCommentStatusSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description: 'Workflow collaboration',
      body: projected(
        'WorkflowCommentCommandResult',
        comments.workflowCommentCommandResultSchema,
      ),
    },
    problems: sharedProblems1,
  }),
  presence: defineRoute({
    operationId: 'getWorkflowPresence',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/presence',
    params: workflowIdParamSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    query: presence.workflowPresenceQuerySchema,
    success: {
      status: 200,
      description: 'Workflow collaboration',
      body: projected('WorkflowPresence', presence.workflowPresenceSchema),
    },
    problems: sharedProblems1,
  }),
  heartbeat: defineRoute({
    operationId: 'heartbeatWorkflowPresence',
    method: 'put',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/presence/{tabId}',
    params: presenceParams,
    access: participating,
    rateLimit: 'ordinary_mutation',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowPresenceHeartbeat',
      presence.workflowPresenceHeartbeatSchema,
    ),
    success: {
      status: 200,
      description: 'Workflow collaboration',
      body: projected(
        'WorkflowPresenceHeartbeatResult',
        presence.workflowPresenceHeartbeatResultSchema,
      ),
    },
    problems: sharedProblems1,
  }),
  leave: defineRoute({
    operationId: 'leaveWorkflowPresence',
    method: 'delete',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/presence/{tabId}',
    params: presenceParams,
    access: participating,
    rateLimit: 'ordinary_mutation',
    cacheControl: 'private, no-store',
    success: { status: 204, response: { description: 'Presence released' } },
    problems: sharedProblems1,
  }),
};
