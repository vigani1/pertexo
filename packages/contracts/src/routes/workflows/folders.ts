import { problemResponse } from '../openapi-primitives.js';
import { workflowIdParamSchema } from '../../schemas/workflows/authoring.js';
import * as folders from '../../schemas/workflows/organization-folders.js';
import * as sharing from '../../schemas/workflows/sharing.js';
import { projected, reading, session, workspaceParams } from './access.js';
const participating = session('workflow:read');

import { responseReference } from '../openapi-primitives.js';
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
export const foldersRoutes = {
  list: defineRoute({
    operationId: 'listWorkflowFolders',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflow-folders',
    params: workspaceParams,
    access: reading,
    rateLimit: 'authenticated_read',
    description:
      'Current workflow:read in an active workspace. At most 256 folders in ascending UUID order with derived depth at most 4; no total count or recursive workflow inventory. Folders never grant authority.',
    cacheControl: 'private, no-store',
    query: folders.workflowFolderListQuerySchema,
    success: {
      status: 200,
      description: 'Bounded folder hierarchy',
      body: projected(
        'WorkflowFolderListResponse',
        folders.workflowFolderListResponseSchema,
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
  sharingPrincipals: defineRoute({
    operationId: 'listResourceSharingPrincipals',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/resource-sharing-principals',
    params: workspaceParams,
    access: reading,
    rateLimit: 'authenticated_read',
    description:
      'Current owner/admin discovers active members or current linked directory groups before pagination; no local group management.',
    cacheControl: 'private, no-store',
    query: sharing.sharingPrincipalsQuerySchema,
    success: {
      status: 200,
      description: 'Bounded current principals',
      body: projected(
        'SharingPrincipalsResponse',
        sharing.sharingPrincipalsResponseSchema,
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
  readSharing: defineRoute({
    operationId: 'readWorkflowFolderSharing',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/sharing',
    params: folders.workflowFolderParamsSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    description: 'Current owner/admin reads bounded folder grants.',
    cacheControl: 'private, no-store',
    success: {
      status: 200,
      description: 'Current sharing',
      body: projected(
        'FolderSharingResponse',
        sharing.folderSharingResponseSchema,
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
  replaceSharing: defineRoute({
    operationId: 'replaceWorkflowFolderSharing',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/sharing',
    params: folders.workflowFolderParamsSchema,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'Current owner/admin replaces at most 100 current member or linked directory group grants with expected folder revision and one audit fact.',
    cacheControl: 'private, no-store',
    body: projected('FolderSharingRequest', sharing.folderSharingRequestSchema),
    idempotent: true,
    success: {
      status: 200,
      description:
        'Original committed metadata and replay marker; reread current state',
      body: projected(
        'FolderSharingCommandResponse',
        sharing.folderSharingCommandResponseSchema,
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
  reviewMove: defineRoute({
    operationId: 'reviewWorkflowMoveAudience',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflow-folders/review-move',
    params: workspaceParams,
    access: participating,
    rateLimit: 'authenticated_read',
    description:
      'Batch review up to 50 visible workflows or one folder. Administrator acknowledgement of the current token is required when a restriction is removed or replaced.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowMoveReviewRequest',
      sharing.workflowMoveReviewRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Current audience review',
      body: projected(
        'WorkflowMoveReviewResponse',
        sharing.workflowMoveReviewResponseSchema,
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
  create: defineRoute({
    operationId: 'createWorkflowFolder',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflow-folders',
    params: workspaceParams,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'Current owner/admin in an active workspace, without broadening workspace:manage. U+0020-trimmed display name; ASCII-only sibling identity is internal. Maximum depth 4 and 256 live folders.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowFolderCreateRequest',
      folders.workflowFolderCreateRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 201,
      description:
        'Original committed metadata and replay marker; reread current state',
      body: projected(
        'WorkflowFolderCreateResponse',
        folders.workflowFolderCreateResponseSchema,
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
  rename: defineRoute({
    operationId: 'renameWorkflowFolder',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/rename',
    params: folders.workflowFolderParamsSchema,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'Current owner/admin; expectedFolderRevision checked. New no-op commands advance once; exact authorized replay does not. Descendants, workflow organization revisions and timestamps remain unchanged.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowFolderRenameRequest',
      folders.workflowFolderRenameRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description:
        'Original committed metadata and replay marker; reread current state',
      body: projected(
        'WorkflowFolderRenameResponse',
        folders.workflowFolderRenameResponseSchema,
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
  move: defineRoute({
    operationId: 'moveWorkflowFolder',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/move',
    params: folders.workflowFolderParamsSchema,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'Current owner/admin; expectedFolderRevision checked. Current destination existence, cycles and entire subtree depth are checked, without a historical destination revision. No-op advances once; replay does not.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowFolderMoveRequest',
      folders.workflowFolderMoveRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description:
        'Original committed metadata and replay marker; reread current state',
      body: projected(
        'WorkflowFolderMoveResponse',
        folders.workflowFolderMoveResponseSchema,
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
  delete: defineRoute({
    operationId: 'deleteWorkflowFolder',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/delete',
    params: folders.workflowFolderParamsSchema,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'Current owner/admin; expectedFolderRevision checked. Any immediate child or assigned workflow, including archived workflows, conflicts with zero changes. No recursive delete or implicit unfiling. Missing/foreign folders are generic 404.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowFolderDeleteRequest',
      folders.workflowFolderDeleteRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description:
        'Original committed metadata and replay marker; reread current state',
      body: projected(
        'WorkflowFolderDeleteResponse',
        folders.workflowFolderDeleteResponseSchema,
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
  place: defineRoute({
    operationId: 'placeWorkflowInFolder',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/folder',
    params: workflowIdParamSchema,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'Current workflow:update for active workflows; archived placement/unfiling requires owner/admin. Independent expectedOrganizationRevision; new no-op advances once, exact authorized replay does not. Current lifecycle and role are rechecked. Graph and workflow timestamps are unchanged.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowFolderPlacementRequest',
      folders.workflowFolderPlacementRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description:
        'Original committed metadata and replay marker; reread current state',
      body: projected(
        'WorkflowFolderPlacementResponse',
        folders.workflowFolderPlacementResponseSchema,
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
};
