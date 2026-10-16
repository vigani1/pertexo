import {
  workflowTestPreparationSchema,
  workflowTestStartRequestSchema,
  workflowTestAcceptedSchema,
  workflowTestListSchema,
  workflowTestDetailSchema,
  workflowTestCancelRequestSchema,
  workflowTestCancelResponseSchema,
} from '../../schemas/execution/workflow-tests.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  responseReference,
  uuidPathParameter,
} from '../primitives.js';
import { projectContractSchema } from '../schema-projection.js';

export function workflowTestContractSchemas(target: 'client' | 'openapi') {
  const schemas = {
    WorkflowTestPreparation: workflowTestPreparationSchema,
    WorkflowTestStartRequest: workflowTestStartRequestSchema,
    WorkflowTestAccepted: workflowTestAcceptedSchema,
    WorkflowTestList: workflowTestListSchema,
    WorkflowTestDetail: workflowTestDetailSchema,
    WorkflowTestCancelRequest: workflowTestCancelRequestSchema,
    WorkflowTestCancelResponse: workflowTestCancelResponseSchema,
  };
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      projectContractSchema(
        name,
        schema,
        name.endsWith('Request') ? 'input' : 'output',
        target,
      ),
    ]),
  );
}
const scope = [
  uuidPathParameter('workspaceId', 'Workspace identifier'),
  uuidPathParameter('workflowId', 'Workflow identifier'),
];
const run = uuidPathParameter('runId', 'Retained draft test identifier');
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '422': responseReference('UnprocessableEntity'),
  '500': responseReference('Unexpected'),
};
export const workflowTestPaths = {
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/tests/prepare': {
    get: {
      operationId: 'prepareWorkflowTest',
      security: [{ cookieSession: [] }],
      parameters: scope,
      responses: {
        '200': jsonResponse(
          'Exact saved draft, matching pins and unpinned effectful steps',
          'WorkflowTestPreparation',
        ),
        ...errors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/tests': {
    get: {
      operationId: 'listWorkflowTests',
      security: [{ cookieSession: [] }],
      parameters: scope,
      responses: {
        '200': jsonResponse(
          'Retained editor test history; separate from real runs',
          'WorkflowTestList',
        ),
        ...errors,
      },
    },
    post: {
      operationId: 'startWorkflowTest',
      security: [{ cookieSession: [] }],
      parameters: [
        ...scope,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('WorkflowTestStartRequest'),
      responses: {
        '202': jsonResponse(
          'Saved draft accepted as a test; unpinned effectful steps require acknowledgement',
          'WorkflowTestAccepted',
        ),
        ...errors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/tests/{runId}': {
    get: {
      operationId: 'getWorkflowTest',
      security: [{ cookieSession: [] }],
      parameters: [...scope, run],
      responses: {
        '200': jsonResponse(
          'Immutable test graph and substitution provenance; use run events for progress and scoped step reads for output',
          'WorkflowTestDetail',
        ),
        ...errors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/tests/{runId}/cancel':
    {
      post: {
        operationId: 'cancelWorkflowTest',
        security: [{ cookieSession: [] }],
        parameters: [...scope, run, csrfHeaderParameter()],
        requestBody: jsonRequest('WorkflowTestCancelRequest'),
        responses: {
          '200': jsonResponse(
            'Cancellation requested idempotently; already settled tests remain settled',
            'WorkflowTestCancelResponse',
          ),
          ...errors,
        },
      },
    },
};
