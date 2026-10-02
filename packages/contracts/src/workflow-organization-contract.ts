import type { z } from 'zod';
import * as organization from './http/workflow-organization.js';
import * as folders from './http/workflow-organization-folders.js';
import {
  workflowOrganizationListQuerySchema,
  workflowOrganizationListResponseSchema,
  workflowOrganizationProjectionResponseSchema,
  workflowCombinedOrganizationProjectionResponseSchema,
  workflowGetQuerySchema,
} from './http/workflow-authoring.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  problemResponse,
  queryParameter,
  responseReference,
  uuidPathParameter,
} from './openapi-primitives.js';

const definitions = {
  WorkflowTagListQuery: [organization.workflowTagListQuerySchema, 'input'],
  WorkflowTagListResponse: [
    organization.workflowTagListResponseSchema,
    'output',
  ],
  WorkflowTagCreateRequest: [
    organization.workflowTagCreateRequestSchema,
    'input',
  ],
  WorkflowTagCreateResponse: [
    organization.workflowTagCreateResponseSchema,
    'output',
  ],
  WorkflowTagRenameRequest: [
    organization.workflowTagRenameRequestSchema,
    'input',
  ],
  WorkflowTagRenameResponse: [
    organization.workflowTagRenameResponseSchema,
    'output',
  ],
  WorkflowTagDeleteRequest: [
    organization.workflowTagDeleteRequestSchema,
    'input',
  ],
  WorkflowTagDeleteResponse: [
    organization.workflowTagDeleteResponseSchema,
    'output',
  ],
  WorkflowTagAssignmentsResponse: [
    organization.workflowTagAssignmentsResponseSchema,
    'output',
  ],
  WorkflowTagReplaceRequest: [
    organization.workflowTagReplaceRequestSchema,
    'input',
  ],
  WorkflowTagReplaceResponse: [
    organization.workflowTagReplaceResponseSchema,
    'output',
  ],
  WorkflowTagCleanupDetachRequest: [
    organization.workflowTagCleanupDetachRequestSchema,
    'input',
  ],
  WorkflowTagCleanupDetachResponse: [
    organization.workflowTagCleanupDetachResponseSchema,
    'output',
  ],
  WorkflowFavoriteRequest: [
    organization.workflowFavoriteRequestSchema,
    'input',
  ],
  WorkflowFavoriteResponse: [
    organization.workflowFavoriteResponseSchema,
    'output',
  ],
  WorkflowOrganizationListQuery: [workflowOrganizationListQuerySchema, 'input'],
  WorkflowOrganizationListResponse: [
    workflowOrganizationListResponseSchema,
    'output',
  ],
  WorkflowOrganizationProjectionResponse: [
    workflowOrganizationProjectionResponseSchema,
    'output',
  ],
  WorkflowCombinedOrganizationProjectionResponse: [
    workflowCombinedOrganizationProjectionResponseSchema,
    'output',
  ],
  WorkflowGetQuery: [workflowGetQuerySchema, 'input'],
  WorkflowFolderListQuery: [folders.workflowFolderListQuerySchema, 'input'],
  WorkflowFolderListResponse: [
    folders.workflowFolderListResponseSchema,
    'output',
  ],
  WorkflowFolderCreateRequest: [
    folders.workflowFolderCreateRequestSchema,
    'input',
  ],
  WorkflowFolderCreateResponse: [
    folders.workflowFolderCreateResponseSchema,
    'output',
  ],
  WorkflowFolderRenameRequest: [
    folders.workflowFolderRenameRequestSchema,
    'input',
  ],
  WorkflowFolderRenameResponse: [
    folders.workflowFolderRenameResponseSchema,
    'output',
  ],
  WorkflowFolderMoveRequest: [folders.workflowFolderMoveRequestSchema, 'input'],
  WorkflowFolderMoveResponse: [
    folders.workflowFolderMoveResponseSchema,
    'output',
  ],
  WorkflowFolderDeleteRequest: [
    folders.workflowFolderDeleteRequestSchema,
    'input',
  ],
  WorkflowFolderDeleteResponse: [
    folders.workflowFolderDeleteResponseSchema,
    'output',
  ],
  WorkflowFolderPlacementRequest: [
    folders.workflowFolderPlacementRequestSchema,
    'input',
  ],
  WorkflowFolderPlacementResponse: [
    folders.workflowFolderPlacementResponseSchema,
    'output',
  ],
  WorkflowOrganizationBulkRequest: [
    folders.workflowOrganizationBulkRequestSchema,
    'input',
  ],
  WorkflowOrganizationBulkResponse: [
    folders.workflowOrganizationBulkResponseSchema,
    'output',
  ],
} as const;

export function workflowOrganizationContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, [schema, io]]) => [
      name,
      project(name, schema, io),
    ]),
  ) as Record<keyof typeof definitions, Projected>;
}

const workspaceParameters = [
  uuidPathParameter('workspaceId', 'Workspace identifier'),
];
const tagParameters = [
  ...workspaceParameters,
  uuidPathParameter('tagId', 'Tag identifier'),
];
const workflowParameters = [
  ...workspaceParameters,
  uuidPathParameter('workflowId', 'Workflow identifier'),
];
const commandHeaders = [csrfHeaderParameter(), idempotencyHeaderParameter()];
const pageParameters = [
  queryParameter('limit', organization.workflowTagListQuerySchema.shape.limit),
  queryParameter('after', organization.workflowTagListQuerySchema.shape.after),
];
const privateHeaders = {
  'Cache-Control': {
    required: true,
    schema: { type: 'string', const: 'private, no-store' },
  },
} as const;
function privateResponse(description: string, name: keyof typeof definitions) {
  return { ...jsonResponse(description, name), headers: privateHeaders };
}
const readProblems = {
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
const commandProblems = {
  ...readProblems,
  '409': problemResponse(
    'Known organization, revision, idempotency or lifecycle conflict; retain uncertain commands for explicit exact recovery',
  ),
};

const folderParameters = [
  ...workspaceParameters,
  uuidPathParameter('folderId', 'Folder identifier'),
];
function folderCommand(
  operationId: string,
  description: string,
  parameters: typeof workspaceParameters,
  request: keyof typeof definitions,
  response: keyof typeof definitions,
  created = false,
) {
  return {
    operationId,
    description,
    security: [{ cookieSession: [] }],
    parameters: [...parameters, ...commandHeaders],
    requestBody: jsonRequest(request),
    responses: {
      [created ? '201' : '200']: privateResponse(
        'Original committed metadata and replay marker; reread current state',
        response,
      ),
      ...commandProblems,
    },
  };
}

export const workflowOrganizationContractPaths = {
  '/v1/workspaces/{workspaceId}/workflow-tags': {
    get: {
      operationId: 'listWorkflowTags',
      description:
        'Current workflow:read in an active workspace. Bounded vocabulary page in ascending UUID order, no total count. Every continuation rechecks current authority.',
      security: [{ cookieSession: [] }],
      parameters: [...workspaceParameters, ...pageParameters],
      responses: {
        '200': privateResponse(
          'Vocabulary page in ascending UUID order',
          'WorkflowTagListResponse',
        ),
        ...readProblems,
      },
    },
    post: {
      operationId: 'createWorkflowTag',
      description:
        'Current owner/admin in an active workspace. Normalize the bounded ASCII key; create shared vocabulary. Exact authorized receipt replay precedes writer policy and does not represent current state.',
      security: [{ cookieSession: [] }],
      parameters: [...workspaceParameters, ...commandHeaders],
      requestBody: jsonRequest('WorkflowTagCreateRequest'),
      responses: {
        '201': privateResponse(
          'Original created tag and replay marker',
          'WorkflowTagCreateResponse',
        ),
        ...commandProblems,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflow-tags/cleanup/detach': {
    post: {
      operationId: 'detachWorkflowTagAssignments',
      description:
        'Current owner/admin; detach 1–50 explicit targets including archived workflows using independent ordered transactions. Recheck authority per item and replay. After forbidden, remaining items are not_processed. outcome_unknown is ambiguous, never a claimed failure. Exact recovery retains the frozen body and item identities; successful receipt metadata is not a current projection.',
      security: [{ cookieSession: [] }],
      parameters: [...workspaceParameters, ...commandHeaders],
      requestBody: jsonRequest('WorkflowTagCleanupDetachRequest'),
      responses: {
        '200': privateResponse(
          'Ordered bounded per-item outcomes',
          'WorkflowTagCleanupDetachResponse',
        ),
        ...commandProblems,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/rename': {
    post: {
      operationId: 'renameWorkflowTag',
      description:
        'Current owner/admin; revision-checked vocabulary rename preserves tag identity and assignments. Exact authorized replay returns historical committed metadata.',
      security: [{ cookieSession: [] }],
      parameters: [...tagParameters, ...commandHeaders],
      requestBody: jsonRequest('WorkflowTagRenameRequest'),
      responses: {
        '200': privateResponse(
          'Original renamed tag and replay marker',
          'WorkflowTagRenameResponse',
        ),
        ...commandProblems,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/delete': {
    post: {
      operationId: 'deleteWorkflowTag',
      description:
        'Current owner/admin; atomic revision-checked deletion detaches at most 50 assignments, including archived workflows. A 51st assignment causes workflow.tag_delete_overflow and zero changes. Explicit cleanup followed by a fresh confirmed delete is required; never implicitly detach all.',
      security: [{ cookieSession: [] }],
      parameters: [...tagParameters, ...commandHeaders],
      requestBody: jsonRequest('WorkflowTagDeleteRequest'),
      responses: {
        '200': privateResponse(
          'Original deletion metadata and replay marker',
          'WorkflowTagDeleteResponse',
        ),
        ...commandProblems,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/workflows': {
    get: {
      operationId: 'listWorkflowTagAssignments',
      description:
        'Current owner/admin; authoritative assignment discovery including archived workflows in ascending workflow UUID order, no total count. Missing/foreign tags return generic not-found, unlike a workflow-list tag filter which returns a scoped empty page.',
      security: [{ cookieSession: [] }],
      parameters: [...tagParameters, ...pageParameters],
      responses: {
        '200': privateResponse(
          'Assignment page in ascending workflow UUID order',
          'WorkflowTagAssignmentsResponse',
        ),
        ...readProblems,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/tags': {
    post: {
      operationId: 'replaceWorkflowTags',
      description:
        'Current workflow:update in an active workspace and active workflow. Replace at most 16 unique shared tag IDs at the independent organization revision. A new accepted no-op advances once; exact authorized replay does not. Does not change graph, name, lifecycle or updated ordering.',
      security: [{ cookieSession: [] }],
      parameters: [...workflowParameters, ...commandHeaders],
      requestBody: jsonRequest('WorkflowTagReplaceRequest'),
      responses: {
        '200': privateResponse(
          'Original replacement metadata and replay marker',
          'WorkflowTagReplaceResponse',
        ),
        ...commandProblems,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/favorite': {
    post: {
      operationId: 'setWorkflowFavorite',
      description:
        'Current workflow:read including viewers, active workspace; archived workflows allowed. Private desired state at an opaque token. Exact current-generation committed replay precedes token verification/expiry/rotation and writer checks. A new command needs an authenticated absence token or current UUID revision. Recovery is bounded to 24 hours; never automatically replace uncertain command identity. No actor or generation selector.',
      security: [{ cookieSession: [] }],
      parameters: [...workflowParameters, ...commandHeaders],
      requestBody: jsonRequest('WorkflowFavoriteRequest'),
      responses: {
        '200': privateResponse(
          'Original private favorite command outcome',
          'WorkflowFavoriteResponse',
        ),
        ...commandProblems,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflow-folders': {
    get: {
      operationId: 'listWorkflowFolders',
      description:
        'Current workflow:read in an active workspace. At most 256 folders in ascending UUID order with derived depth at most 4; no total count or recursive workflow inventory. Folders never grant authority.',
      security: [{ cookieSession: [] }],
      parameters: workspaceParameters,
      responses: {
        '200': privateResponse(
          'Bounded folder hierarchy',
          'WorkflowFolderListResponse',
        ),
        ...readProblems,
      },
    },
    post: folderCommand(
      'createWorkflowFolder',
      'Current owner/admin in an active workspace, without broadening workspace:manage. U+0020-trimmed display name; ASCII-only sibling identity is internal. Maximum depth 4 and 256 live folders.',
      workspaceParameters,
      'WorkflowFolderCreateRequest',
      'WorkflowFolderCreateResponse',
      true,
    ),
  },
  '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/rename': {
    post: folderCommand(
      'renameWorkflowFolder',
      'Current owner/admin; expectedFolderRevision checked. New no-op commands advance once; exact authorized replay does not. Descendants, workflow organization revisions and timestamps remain unchanged.',
      folderParameters,
      'WorkflowFolderRenameRequest',
      'WorkflowFolderRenameResponse',
    ),
  },
  '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/move': {
    post: folderCommand(
      'moveWorkflowFolder',
      'Current owner/admin; expectedFolderRevision checked. Current destination existence, cycles and entire subtree depth are checked, without a historical destination revision. No-op advances once; replay does not.',
      folderParameters,
      'WorkflowFolderMoveRequest',
      'WorkflowFolderMoveResponse',
    ),
  },
  '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/delete': {
    post: folderCommand(
      'deleteWorkflowFolder',
      'Current owner/admin; expectedFolderRevision checked. Any immediate child or assigned workflow, including archived workflows, conflicts with zero changes. No recursive delete or implicit unfiling. Missing/foreign folders are generic 404.',
      folderParameters,
      'WorkflowFolderDeleteRequest',
      'WorkflowFolderDeleteResponse',
    ),
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/folder': {
    post: folderCommand(
      'placeWorkflowInFolder',
      'Current workflow:update for active workflows; archived placement/unfiling requires owner/admin. Independent expectedOrganizationRevision; new no-op advances once, exact authorized replay does not. Current lifecycle and role are rechecked. Graph and workflow timestamps are unchanged.',
      workflowParameters,
      'WorkflowFolderPlacementRequest',
      'WorkflowFolderPlacementResponse',
    ),
  },
  '/v1/workspaces/{workspaceId}/workflows/organization/bulk': {
    post: folderCommand(
      'updateWorkflowOrganizationBulk',
      'One move or replace_tags operation over 1–50 explicit ordered unique workflows, never select-all. Active workflows require workflow:update; archived move requires owner/admin, archived tag replacement is forbidden. Full-parent identity is admitted before independent sequential item transactions; admission is not atomic completion. Retain the entire frozen body/key on unknown outcomes; exact recovery is bounded to 24 hours. Recheck current authority per item/replay; forbidden stops processing and remaining items are not_processed. Historical replay is not current projection; no internal hash, proof or actor selectors.',
      workspaceParameters,
      'WorkflowOrganizationBulkRequest',
      'WorkflowOrganizationBulkResponse',
    ),
  },
};

export const workflowOrganizationListReadContract = {
  parameters: Object.entries(workflowOrganizationListQuerySchema.shape).map(
    ([name, schema]) => queryParameter(name, schema),
  ),
  response: {
    description:
      'Default or filtered workflow summaries; include=organization explicitly requests private organization metadata. Filters apply before bounded pagination; unknown/foreign tag or folder filters return an empty scoped page. folderId selects an exact UUID without descendants, root selects unfiled, and omission includes all placements. Live pagination is not a snapshot and has no total count.',
    headers: {
      'Cache-Control': {
        schema: { type: 'string', const: 'private, no-store' },
      },
    },
    content: {
      'application/json': {
        schema: {
          anyOf: [
            { $ref: '#/components/schemas/WorkflowListResponse' },
            { $ref: '#/components/schemas/WorkflowOrganizationListResponse' },
          ],
        },
      },
    },
  },
} as const;
export const workflowOrganizationGetReadContract = {
  parameter: queryParameter('include', workflowGetQuerySchema.shape.include),
  response: {
    description:
      'Unchanged default metadata, or the exact requested template-origin and/or organization projection. Unsupported readers are unavailable, never fabricated empty metadata.',
    headers: {
      'Cache-Control': {
        schema: { type: 'string', const: 'private, no-store' },
      },
    },
    content: {
      'application/json': {
        schema: {
          oneOf: [
            { $ref: '#/components/schemas/WorkflowSummaryResponse' },
            {
              $ref: '#/components/schemas/WorkflowTemplateOriginProjectionResponse',
            },
            {
              $ref: '#/components/schemas/WorkflowOrganizationProjectionResponse',
            },
            {
              $ref: '#/components/schemas/WorkflowCombinedOrganizationProjectionResponse',
            },
          ],
        },
      },
    },
  },
} as const;
