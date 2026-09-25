import type { z } from 'zod';

import {
  workflowLifecycleConflictProblemSchema,
  workflowLifecycleRequestSchema,
  workflowLifecycleResponseSchema,
  workflowNameConflictProblemSchema,
  workflowRenameRequestSchema,
  workflowRenameResponseSchema,
} from './http/workflow-authoring.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  responseReference,
  uuidPathParameter as pathParameter,
} from './openapi-primitives.js';

/**
 * Workflow commands that carry an expected aggregate revision in a strict
 * body: archive/restore (ADR 034, lifecycle revision) and rename (ADR 041,
 * name revision). Each revision is independent of drafts and of the other.
 */
export function workflowRevisionCommandSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    WorkflowLifecycleRequest: project(
      'WorkflowLifecycleRequest',
      workflowLifecycleRequestSchema,
      'input',
    ),
    WorkflowLifecycleResponse: project(
      'WorkflowLifecycleResponse',
      workflowLifecycleResponseSchema,
      'output',
    ),
    WorkflowLifecycleConflictProblem: project(
      'WorkflowLifecycleConflictProblem',
      workflowLifecycleConflictProblemSchema,
      'output',
    ),
    WorkflowRenameRequest: project(
      'WorkflowRenameRequest',
      workflowRenameRequestSchema,
      'input',
    ),
    WorkflowRenameResponse: project(
      'WorkflowRenameResponse',
      workflowRenameResponseSchema,
      'output',
    ),
    WorkflowNameConflictProblem: project(
      'WorkflowNameConflictProblem',
      workflowNameConflictProblemSchema,
      'output',
    ),
  };
}

type RevisionCommandSchemaName = keyof ReturnType<
  typeof workflowRevisionCommandSchemas
>;

const workflowParameters = [
  pathParameter('workspaceId', 'Workspace identifier'),
  pathParameter('workflowId', 'Workflow identifier'),
] as const;

/**
 * A POST-to-verb command with a strict expected-revision body and exactly one
 * Idempotency-Key. A stale revision returns the command's typed 409 problem.
 */
function revisionCommandOperation(
  input: Readonly<{
    operationId: string;
    description: string;
    requestBody: RevisionCommandSchemaName;
    success: Readonly<{
      status: '200' | '202';
      description: string;
      body: RevisionCommandSchemaName;
    }>;
    conflict: Readonly<{
      description: string;
      problem: RevisionCommandSchemaName;
    }>;
  }>,
) {
  return {
    operationId: input.operationId,
    description: input.description,
    security: [{ cookieSession: [] }],
    parameters: [
      ...workflowParameters,
      csrfHeaderParameter(),
      idempotencyHeaderParameter(),
    ],
    requestBody: jsonRequest(input.requestBody),
    responses: {
      [input.success.status]: jsonResponse(
        input.success.description,
        input.success.body,
      ),
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': {
        description: input.conflict.description,
        content: {
          'application/problem+json': {
            schema: {
              oneOf: [
                { $ref: `#/components/schemas/${input.conflict.problem}` },
                { $ref: '#/components/schemas/ApiProblem' },
              ],
            },
          },
        },
      },
      '500': responseReference('Unexpected'),
    },
  };
}

function lifecycleOperation(
  operationId: 'archiveWorkflow' | 'restoreWorkflow',
) {
  return revisionCommandOperation({
    operationId,
    description:
      'Change desired lifecycle without changing drafts, published versions, or existing runs. Exact idempotent retries return the original accepted summary.',
    requestBody: 'WorkflowLifecycleRequest',
    success: {
      status: '202',
      description: 'Workflow lifecycle accepted',
      body: 'WorkflowLifecycleResponse',
    },
    conflict: {
      description: 'Lifecycle revision or idempotency conflict',
      problem: 'WorkflowLifecycleConflictProblem',
    },
  });
}

export const workflowRevisionCommandPaths = Object.freeze({
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/archive': {
    post: lifecycleOperation('archiveWorkflow'),
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/restore': {
    post: lifecycleOperation('restoreWorkflow'),
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/rename': {
    post: revisionCommandOperation({
      operationId: 'renameWorkflow',
      description:
        'Change the display name at the expected name revision without changing drafts, published versions, lifecycle, or runs. Exact idempotent retries return the original accepted summary.',
      requestBody: 'WorkflowRenameRequest',
      success: {
        status: '200',
        description: 'Workflow renamed',
        body: 'WorkflowRenameResponse',
      },
      conflict: {
        description: 'Name revision or idempotency conflict',
        problem: 'WorkflowNameConflictProblem',
      },
    }),
  },
});
