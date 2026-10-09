import type { z } from 'zod';

import * as schemas from '../../schemas/workflows/auto-pause.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  responseReference,
  uuidPathParameter,
} from '../primitives.js';

export function workflowAutoPauseContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    WorkflowAutoPauseSettings: project(
      'WorkflowAutoPauseSettings',
      schemas.workflowAutoPauseSettingsSchema,
      'output',
    ),
    WorkspaceAutoPauseSettings: project(
      'WorkspaceAutoPauseSettings',
      schemas.workspaceAutoPauseSettingsSchema,
      'output',
    ),
    WorkflowAutoPauseSettingsRequest: project(
      'WorkflowAutoPauseSettingsRequest',
      schemas.workflowAutoPauseSettingsRequestSchema,
      'input',
    ),
    WorkspaceAutoPauseSettingsRequest: project(
      'WorkspaceAutoPauseSettingsRequest',
      schemas.workspaceAutoPauseSettingsRequestSchema,
      'input',
    ),
    WorkflowResumeRequest: project(
      'WorkflowResumeRequest',
      schemas.workflowResumeRequestSchema,
      'input',
    ),
    WorkflowAutoPauseCommandResponse: project(
      'WorkflowAutoPauseCommandResponse',
      schemas.workflowAutoPauseCommandResponseSchema,
      'output',
    ),
    WorkspaceAutoPauseCommandResponse: project(
      'WorkspaceAutoPauseCommandResponse',
      schemas.workspaceAutoPauseCommandResponseSchema,
      'output',
    ),
    WorkflowPauseConflictProblem: project(
      'WorkflowPauseConflictProblem',
      schemas.workflowPauseConflictProblemSchema,
      'output',
    ),
    WorkflowAutoPauseSettingsConflictProblem: project(
      'WorkflowAutoPauseSettingsConflictProblem',
      schemas.workflowAutoPauseSettingsConflictProblemSchema,
      'output',
    ),
    WorkspaceAutoPauseSettingsConflictProblem: project(
      'WorkspaceAutoPauseSettingsConflictProblem',
      schemas.workspaceAutoPauseSettingsConflictProblemSchema,
      'output',
    ),
  };
}

type SchemaName = keyof ReturnType<typeof workflowAutoPauseContractSchemas>;
const workspaceParameters = [
  uuidPathParameter('workspaceId', 'Workspace identifier'),
];
const workflowParameters = [
  ...workspaceParameters,
  uuidPathParameter('workflowId', 'Workflow identifier'),
];
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '500': responseReference('Unexpected'),
};

function readOperation(
  operationId: string,
  description: string,
  body: SchemaName,
  parameters: typeof workspaceParameters,
) {
  return {
    operationId,
    description,
    security: [{ cookieSession: [] }],
    parameters,
    responses: { '200': jsonResponse(description, body), ...errors },
  };
}

function commandOperation(
  operationId: string,
  description: string,
  request: SchemaName,
  response: SchemaName,
  conflict: SchemaName,
  parameters: typeof workspaceParameters,
) {
  return {
    operationId,
    description,
    security: [{ cookieSession: [] }],
    parameters: [
      ...parameters,
      csrfHeaderParameter(),
      idempotencyHeaderParameter(),
    ],
    requestBody: jsonRequest(request),
    responses: {
      '200': jsonResponse(
        'Command accepted; exact retries replay the original settings snapshot',
        response,
      ),
      ...errors,
      '409': {
        description: 'Expected revision or idempotency conflict',
        content: {
          'application/problem+json': {
            schema: {
              oneOf: [
                { $ref: `#/components/schemas/${conflict}` },
                { $ref: '#/components/schemas/ApiProblem' },
              ],
            },
          },
        },
      },
    },
  };
}

export const workflowAutoPauseContractPaths = {
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/auto-pause': {
    get: readOperation(
      'getWorkflowAutoPauseSettings',
      'Read automatic-trigger pause state and effective settings. Requires workflow:read.',
      'WorkflowAutoPauseSettings',
      workflowParameters,
    ),
    put: commandOperation(
      'updateWorkflowAutoPauseSettings',
      'Update override or opt-out at the independent settings revision. Requires workflow:update. Does not resume, publish, enable triggers, or retroactively evaluate outcomes.',
      'WorkflowAutoPauseSettingsRequest',
      'WorkflowAutoPauseCommandResponse',
      'WorkflowAutoPauseSettingsConflictProblem',
      workflowParameters,
    ),
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/resume': {
    post: commandOperation(
      'resumeWorkflow',
      'Explicitly clear automatic-trigger pause and reset the failure streak at the expected pause revision. Requires workflow:publish. An already-unpaused workflow is a no-op. Existing trigger disable states and workflow lifecycle are preserved.',
      'WorkflowResumeRequest',
      'WorkflowAutoPauseCommandResponse',
      'WorkflowPauseConflictProblem',
      workflowParameters,
    ),
  },
  '/v1/workspaces/{workspaceId}/auto-pause': {
    get: readOperation(
      'getWorkspaceAutoPauseSettings',
      'Read workspace automatic-pause default. Requires workspace:read.',
      'WorkspaceAutoPauseSettings',
      workspaceParameters,
    ),
    put: commandOperation(
      'updateWorkspaceAutoPauseSettings',
      'Update the workspace default threshold at the expected workspace revision. Requires workspace:manage (owner only). Does not resume or retroactively evaluate workflows.',
      'WorkspaceAutoPauseSettingsRequest',
      'WorkspaceAutoPauseCommandResponse',
      'WorkspaceAutoPauseSettingsConflictProblem',
      workspaceParameters,
    ),
  },
};
