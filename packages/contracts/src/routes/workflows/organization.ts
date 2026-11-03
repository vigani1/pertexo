import { problemResponse } from '../../openapi/primitives.js';
import { workflowIdParamSchema } from '../../schemas/workflows/authoring.js';
import * as organization from '../../schemas/workflows/organization.js';
import {
  projected,
  reading,
  session,
  updating,
  workspaceParams,
} from './access.js';
const participating = session('workflow:read');

import { responseReference } from '../../openapi/primitives.js';
import { defineRoute } from '../define.js';
const sharedProblems1 = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '429': problemResponse('Request rate limit reached'),
  '500': responseReference('Unexpected'),
  '503': problemResponse(
    'Workflow organization or request admission is unavailable; no empty metadata is inferred',
  ),
};
const sharedProblems2 = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': problemResponse(
    'Known organization, revision, idempotency or lifecycle conflict; retain uncertain commands for explicit exact recovery',
  ),
  '429': problemResponse('Request rate limit reached'),
  '500': responseReference('Unexpected'),
  '503': problemResponse(
    'Workflow organization or request admission is unavailable; no empty metadata is inferred',
  ),
};
export const organizationRoutes = {
  listTags: defineRoute({
    operationId: 'listWorkflowTags',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflow-tags',
    params: workspaceParams,
    access: { ...reading, auth: 'session_or_token' },
    rateLimit: 'authenticated_read',
    description:
      'Current workflow:read in an active workspace. Bounded vocabulary page in ascending UUID order, no total count. Every continuation rechecks current authority.',
    cacheControl: 'private, no-store',
    query: organization.workflowTagListQuerySchema,
    success: {
      status: 200,
      description: 'Vocabulary page in ascending UUID order',
      body: projected(
        'WorkflowTagListResponse',
        organization.workflowTagListResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    problems: sharedProblems1,
  }),
  createTag: defineRoute({
    operationId: 'createWorkflowTag',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflow-tags',
    params: workspaceParams,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'Current owner/admin in an active workspace. Normalize the bounded ASCII key; create shared vocabulary. Exact authorized receipt replay precedes writer policy and does not represent current state.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowTagCreateRequest',
      organization.workflowTagCreateRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 201,
      description: 'Original created tag and replay marker',
      body: projected(
        'WorkflowTagCreateResponse',
        organization.workflowTagCreateResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    problems: sharedProblems2,
  }),
  renameTag: defineRoute({
    operationId: 'renameWorkflowTag',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/rename',
    params: organization.workflowTagParamsSchema,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'Current owner/admin; revision-checked vocabulary rename preserves tag identity and assignments. Exact authorized replay returns historical committed metadata.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowTagRenameRequest',
      organization.workflowTagRenameRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description: 'Original renamed tag and replay marker',
      body: projected(
        'WorkflowTagRenameResponse',
        organization.workflowTagRenameResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    problems: sharedProblems2,
  }),
  deleteTag: defineRoute({
    operationId: 'deleteWorkflowTag',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/delete',
    params: organization.workflowTagParamsSchema,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'Current owner/admin; atomic revision-checked deletion detaches at most 50 assignments, including archived workflows. A 51st assignment causes workflow.tag_delete_overflow and zero changes. Explicit cleanup followed by a fresh confirmed delete is required; never implicitly detach all.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowTagDeleteRequest',
      organization.workflowTagDeleteRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description: 'Original deletion metadata and replay marker',
      body: projected(
        'WorkflowTagDeleteResponse',
        organization.workflowTagDeleteResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    problems: sharedProblems2,
  }),
  assignments: defineRoute({
    operationId: 'listWorkflowTagAssignments',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/workflows',
    params: organization.workflowTagParamsSchema,
    access: { ...reading, auth: 'session_or_token' },
    rateLimit: 'authenticated_read',
    description:
      'Current owner/admin; authoritative assignment discovery including archived workflows in ascending workflow UUID order, no total count. Missing/foreign tags return generic not-found, unlike a workflow-list tag filter which returns a scoped empty page.',
    cacheControl: 'private, no-store',
    query: organization.workflowTagListQuerySchema,
    success: {
      status: 200,
      description: 'Assignment page in ascending workflow UUID order',
      body: projected(
        'WorkflowTagAssignmentsResponse',
        organization.workflowTagAssignmentsResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    problems: sharedProblems1,
  }),
  replaceTags: defineRoute({
    operationId: 'replaceWorkflowTags',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/tags',
    params: workflowIdParamSchema,
    access: { ...updating, auth: 'session_or_token' },
    rateLimit: 'ordinary_mutation',
    description:
      'Current workflow:update in an active workspace and active workflow. Replace at most 16 unique shared tag IDs at the independent organization revision. A new accepted no-op advances once; exact authorized replay does not. Does not change graph, name, lifecycle or updated ordering.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowTagReplaceRequest',
      organization.workflowTagReplaceRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description: 'Original replacement metadata and replay marker',
      body: projected(
        'WorkflowTagReplaceResponse',
        organization.workflowTagReplaceResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    problems: sharedProblems2,
  }),
  favorite: defineRoute({
    operationId: 'setWorkflowFavorite',
    method: 'put',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/favorite',
    params: workflowIdParamSchema,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      "Current workflow:read including viewers, active workspace; archived workflows allowed. Marks or unmarks the workflow as one of the actor's private favorites. Asking for the current state changes nothing, so a retry is safe without an idempotency key.",
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowFavoriteRequest',
      organization.workflowFavoriteRequestSchema,
    ),
    success: {
      status: 200,
      description: "The actor's favorite state",
      body: projected(
        'WorkflowFavoriteResponse',
        organization.workflowFavoriteResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    problems: sharedProblems1,
  }),
};
