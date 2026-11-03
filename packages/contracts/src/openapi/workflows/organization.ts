import type { z } from 'zod';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { foldersRoutes } from '../../routes/workflows/folders.js';
import { organizationRoutes } from '../../routes/workflows/organization.js';
import {
  workflowCombinedOrganizationProjectionResponseSchema,
  workflowGetQuerySchema,
  workflowOrganizationListQuerySchema,
  workflowOrganizationListResponseSchema,
  workflowOrganizationProjectionResponseSchema,
} from '../../schemas/workflows/authoring.js';
import * as folders from '../../schemas/workflows/organization-folders.js';
import * as organization from '../../schemas/workflows/organization.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  problemResponse,
  responseReference,
  uuidPathParameter,
} from '../primitives.js';

const definitions = {
  WorkflowTagListQuery: [organization.workflowTagListQuerySchema, 'input'],

  WorkflowTagCleanupDetachRequest: [
    organization.workflowTagCleanupDetachRequestSchema,
    'input',
  ],
  WorkflowTagCleanupDetachResponse: [
    organization.workflowTagCleanupDetachResponseSchema,
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
  return {
    ...routeSchemas(Object.values(foldersRoutes)),
    ...routeSchemas(Object.values(organizationRoutes)),
    ...(Object.fromEntries(
      Object.entries(definitions).map(([name, [schema, io]]) => [
        name,
        project(name, schema, io),
      ]),
    ) as Record<keyof typeof definitions, Projected>),
  };
}

const workspaceParameters = [
  uuidPathParameter('workspaceId', 'Workspace identifier'),
];

const commandHeaders = [csrfHeaderParameter(), idempotencyHeaderParameter()];

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

function folderCommand({
  operationId,
  description,
  parameters,
  request,
  response,
  created = false,
}: Readonly<{
  operationId: string;
  description: string;
  parameters: typeof workspaceParameters;
  request: keyof typeof definitions;
  response: keyof typeof definitions;
  created?: boolean;
}>) {
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
  ...routePaths(Object.values(foldersRoutes)),
  ...routePaths(Object.values(organizationRoutes)),

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

  '/v1/workspaces/{workspaceId}/workflows/organization/bulk': {
    post: folderCommand({
      operationId: 'updateWorkflowOrganizationBulk',
      description:
        'One move or replace_tags operation over 1–50 explicit ordered unique workflows, never select-all. Active workflows require workflow:update; archived move requires owner/admin, archived tag replacement is forbidden. Full-parent identity is admitted before independent sequential item transactions; admission is not atomic completion. Retain the entire frozen body/key on unknown outcomes; exact recovery is bounded to 24 hours. Recheck current authority per item/replay; forbidden stops processing and remaining items are not_processed. Historical replay is not current projection; no internal hash, proof or actor selectors.',
      parameters: workspaceParameters,
      request: 'WorkflowOrganizationBulkRequest',
      response: 'WorkflowOrganizationBulkResponse',
    }),
  },
};
