import type { z } from 'zod';
import * as schemas from '../../schemas/workflows/error.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  responseReference,
  uuidPathParameter,
} from '../primitives.js';

export function workflowErrorContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    WorkflowErrorTargetsPage: project(
      'WorkflowErrorTargetsPage',
      schemas.workflowErrorTargetsPageSchema,
      'output',
    ),
    WorkflowErrorSettings: project(
      'WorkflowErrorSettings',
      schemas.workflowErrorSettingsSchema,
      'output',
    ),
    WorkflowErrorSettingsRequest: project(
      'WorkflowErrorSettingsRequest',
      schemas.workflowErrorSettingsRequestSchema,
      'input',
    ),
    WorkflowErrorSettingsResponse: project(
      'WorkflowErrorSettingsResponse',
      schemas.workflowErrorSettingsResponseSchema,
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
export const workflowErrorContractPaths = {
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/error-workflow/targets':
    {
      get: {
        operationId: 'listWorkflowErrorTargets',
        description:
          'List a bounded page of active published error-workflow targets editable by the current person. Requires workflow:update. The current workflow is excluded.',
        security: [{ cookieSession: [] }],
        parameters: [
          ...parameters,
          {
            name: 'after',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': jsonResponse(
            'Eligible targets and next cursor',
            'WorkflowErrorTargetsPage',
          ),
          ...errors,
        },
      },
    },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/error-workflow': {
    get: {
      operationId: 'getWorkflowErrorSettings',
      description:
        'Read the current error-workflow target. Requires workflow:read in the active workspace.',
      security: [{ cookieSession: [] }],
      parameters,
      responses: {
        '200': jsonResponse(
          'Current workflow error-workflow snapshot',
          'WorkflowErrorSettings',
        ),
        ...errors,
      },
    },
    put: {
      operationId: 'updateWorkflowErrorSettings',
      description:
        'Select a published error workflow in this workspace or clear it. Requires workflow:update on source and target. Revision and idempotency protect concurrent updates.',
      security: [{ cookieSession: [] }],
      parameters: [
        ...parameters,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('WorkflowErrorSettingsRequest'),
      responses: {
        '200': jsonResponse(
          'Settings snapshot; exact retries replay the original result',
          'WorkflowErrorSettingsResponse',
        ),
        ...errors,
        '409': responseReference('Conflict'),
      },
    },
  },
};
