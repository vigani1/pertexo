import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { z } from 'zod';

import { responseReference } from '../../openapi/primitives.js';
import {
  workspaceInboxListQuerySchema,
  workspaceInboxListResponseSchema,
  workspaceInboxReadAllRequestSchema,
  workspaceInboxReadAllResponseSchema,
  workspaceInboxReadRequestSchema,
  workspaceInboxReadResponseSchema,
  workspaceInboxSummaryResponseSchema,
  workspaceInboxThreadParamsSchema,
} from '../../schemas/identity/inbox.js';
import { defineRoute, named, type RouteAccess } from '../define.js';

const ROOT = '/v1/workspaces/{workspaceId}/notifications';
const workspace = z.object({ workspaceId: z.uuid() });

// ADR 055, narrowed by ADR 013/027: a suspended workspace's inbox still reads.
const reading: RouteAccess = {
  auth: 'session',
  capabilities: [
    {
      name: 'workspace:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
// Marking read needs an active workspace.
const changing: RouteAccess = {
  auth: 'session',
  capabilities: [
    {
      name: 'workspace:read',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const readProblems = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '404': responseReference('InboxNotFound'),
  '429': responseReference('RateLimited'),
  '500': responseReference('Unexpected'),
};
const commandProblems = {
  ...readProblems,
  '403': responseReference('Forbidden'),
};

/** ADR 055: failure threads read on demand, with private read state. */
export const inboxRoutes = {
  list: defineRoute({
    operationId: 'listWorkspaceInbox',
    method: 'get',
    path: ROOT,
    params: workspace,
    query: workspaceInboxListQuerySchema,
    access: reading,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Failing workflows, newest failure first',
      body: named(
        'WorkspaceInboxListResponse',
        workspaceInboxListResponseSchema,
      ),
    },
    problems: readProblems,
  }),
  summary: defineRoute({
    operationId: 'getWorkspaceInboxSummary',
    method: 'get',
    path: `${ROOT}/summary`,
    params: workspace,
    access: reading,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Unread thread count',
      body: named(
        'WorkspaceInboxSummaryResponse',
        workspaceInboxSummaryResponseSchema,
      ),
    },
    problems: readProblems,
  }),
  read: defineRoute({
    operationId: 'markWorkspaceInboxThreadRead',
    method: 'post',
    path: `${ROOT}/{threadId}/read`,
    params: workspaceInboxThreadParamsSchema,
    access: changing,
    rateLimit: 'ordinary_mutation',
    body: named('WorkspaceInboxReadRequest', workspaceInboxReadRequestSchema),
    success: {
      status: 200,
      description: 'Monotonic, private read of the seen revision',
      body: named(
        'WorkspaceInboxReadResponse',
        workspaceInboxReadResponseSchema,
      ),
    },
    problems: commandProblems,
  }),
  readAll: defineRoute({
    operationId: 'markWorkspaceInboxRead',
    method: 'post',
    path: `${ROOT}/read-all`,
    params: workspace,
    access: changing,
    rateLimit: 'ordinary_mutation',
    body: named(
      'WorkspaceInboxReadAllRequest',
      workspaceInboxReadAllRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Threads at or below the seen revision are read',
      body: named(
        'WorkspaceInboxReadAllResponse',
        workspaceInboxReadAllResponseSchema,
      ),
    },
    problems: commandProblems,
  }),
  events: defineRoute({
    operationId: 'streamWorkspaceInboxHints',
    method: 'get',
    path: `${ROOT}/events`,
    params: workspace,
    access: reading,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      response: {
        description:
          'Server-sent `inbox.ready` and `inbox.changed` hints whose data is a WorkspaceInboxStreamEvent',
        content: {
          'text/event-stream': {
            schema: { $ref: '#/components/schemas/WorkspaceInboxStreamEvent' },
          },
        },
      },
    },
    problems: readProblems,
  }),
};
