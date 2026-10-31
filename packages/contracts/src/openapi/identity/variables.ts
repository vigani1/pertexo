import {
  workspaceVariablesResponseSchema,
  workspaceVariablesRequestSchema,
  workspaceVariablesCommandResponseSchema,
  workspaceVariableUsageQuerySchema,
  workspaceVariableUsageResponseSchema,
} from '../../schemas/identity/variables.js';
import {
  jsonSchema,
  jsonResponse,
  jsonRequest,
  uuidPathParameter,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  queryParameter,
  problemResponse,
} from '../primitives.js';
export const variableContractSchemas = {
  WorkspaceVariablesResponse: jsonSchema(
    workspaceVariablesResponseSchema,
    'output',
  ),
  WorkspaceVariablesRequest: jsonSchema(
    workspaceVariablesRequestSchema,
    'input',
  ),
  WorkspaceVariablesCommandResponse: jsonSchema(
    workspaceVariablesCommandResponseSchema,
    'output',
  ),
  WorkspaceVariableUsageResponse: jsonSchema(
    workspaceVariableUsageResponseSchema,
    'output',
  ),
};
const scope = [uuidPathParameter('workspaceId')];
const errors = {
  '400': problemResponse('Invalid request'),
  '401': problemResponse('Session required'),
  '403': problemResponse('CSRF refused'),
  '404': problemResponse('Workspace unavailable'),
  '409': problemResponse('Variables or workflow references changed'),
  '429': problemResponse('Rate limited'),
  '500': problemResponse('Unexpected failure'),
};
export const variableContractPaths = {
  '/v1/workspaces/{workspaceId}/variables': {
    get: {
      operationId: 'getWorkspaceVariables',
      security: [{ cookieSession: [] }],
      parameters: scope,
      responses: {
        '200': jsonResponse(
          'Non-secret current workspace values',
          'WorkspaceVariablesResponse',
        ),
        ...errors,
      },
    },
    put: {
      operationId: 'replaceWorkspaceVariables',
      security: [{ cookieSession: [] }],
      parameters: [
        ...scope,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('WorkspaceVariablesRequest'),
      responses: {
        '200': jsonResponse(
          'Recorded revision, without copying values into the command receipt',
          'WorkspaceVariablesCommandResponse',
        ),
        ...errors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/variables/usage': {
    get: {
      operationId: 'listWorkspaceVariableReferences',
      security: [{ cookieSession: [] }],
      parameters: [
        ...scope,
        queryParameter('name', workspaceVariableUsageQuerySchema.shape.name),
        queryParameter('after', workspaceVariableUsageQuerySchema.shape.after),
        queryParameter('limit', workspaceVariableUsageQuerySchema.shape.limit),
      ],
      responses: {
        '200': jsonResponse(
          'One bounded page, spanning workflows while its budgets last; follow the cursor to the end before declaring a name unused',
          'WorkspaceVariableUsageResponse',
        ),
        ...errors,
      },
    },
  },
};
