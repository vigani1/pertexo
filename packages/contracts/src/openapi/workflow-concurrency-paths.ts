import type { z } from 'zod';
import * as schemas from '../schemas/workflow-concurrency.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  responseReference,
  uuidPathParameter,
} from './primitives.js';

export function workflowConcurrencyContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    WorkflowConcurrencySettings: project(
      'WorkflowConcurrencySettings',
      schemas.workflowConcurrencySettingsSchema,
      'output',
    ),
    WorkflowConcurrencySettingsRequest: project(
      'WorkflowConcurrencySettingsRequest',
      schemas.workflowConcurrencySettingsRequestSchema,
      'input',
    ),
    WorkflowConcurrencyCommandResponse: project(
      'WorkflowConcurrencyCommandResponse',
      schemas.workflowConcurrencyCommandResponseSchema,
      'output',
    ),
    WorkflowConcurrencyRevisionConflictProblem: project(
      'WorkflowConcurrencyRevisionConflictProblem',
      schemas.workflowConcurrencyRevisionConflictProblemSchema,
      'output',
    ),
    WorkflowConcurrencyLimitExceededProblem: project(
      'WorkflowConcurrencyLimitExceededProblem',
      schemas.workflowConcurrencyLimitExceededProblemSchema,
      'output',
    ),
  };
}
const parameters = [
  uuidPathParameter('workspaceId', 'Workspace identifier'),
  uuidPathParameter('workflowId', 'Workflow identifier'),
];
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '500': responseReference('Unexpected'),
};
export const workflowConcurrencyContractPaths = {
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/concurrency': {
    get: {
      operationId: 'getWorkflowConcurrencySettings',
      description:
        'Read current operational concurrency policy. Requires workflow:read and active workspace. No-store snapshot; null adds no workflow cap, not unlimited workspace capacity.',
      security: [{ cookieSession: [] }],
      parameters,
      responses: {
        '200': jsonResponse(
          'Current workflow concurrency snapshot',
          'WorkflowConcurrencySettings',
        ),
        ...errors,
      },
    },
    put: {
      operationId: 'updateWorkflowConcurrencySettings',
      description:
        'Update queue-only concurrency policy at its independent revision. Requires workflow:update and active workspace. Positive cap requires active workspace entitlement; committed reservations are grandfathered. Does not publish or change trigger pause.',
      security: [{ cookieSession: [] }],
      parameters: [
        ...parameters,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('WorkflowConcurrencySettingsRequest'),
      responses: {
        '200': jsonResponse(
          'Settings snapshot; exact retries replay the original result',
          'WorkflowConcurrencyCommandResponse',
        ),
        ...errors,
        '409': {
          description: 'Revision, current entitlement or idempotency conflict',
          content: {
            'application/problem+json': {
              schema: {
                oneOf: [
                  {
                    $ref: '#/components/schemas/WorkflowConcurrencyRevisionConflictProblem',
                  },
                  {
                    $ref: '#/components/schemas/WorkflowConcurrencyLimitExceededProblem',
                  },
                  { $ref: '#/components/schemas/ApiProblem' },
                ],
              },
            },
          },
        },
      },
    },
  },
};
