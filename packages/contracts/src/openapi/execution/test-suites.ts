import {
  workflowTestSuitePreparationSchema,
  workflowTestSuiteStartRequestSchema,
  workflowTestSuiteAcceptedSchema,
  workflowTestSuiteListSchema,
  workflowTestSuiteDetailSchema,
  workflowTestSuiteCaseReportSchema,
} from '../../schemas/execution/test-suites.js';
import {
  workflowTestCancelRequestSchema,
  workflowTestCancelResponseSchema,
} from '../../schemas/execution/workflow-tests.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  responseReference,
  problemResponse,
  uuidPathParameter,
} from '../primitives.js';
import { projectContractSchema } from '../schema-projection.js';
export function workflowTestSuiteContractSchemas(target: 'client' | 'openapi') {
  const schemas = {
    WorkflowTestSuitePreparation: workflowTestSuitePreparationSchema,
    WorkflowTestSuiteStartRequest: workflowTestSuiteStartRequestSchema,
    WorkflowTestSuiteAccepted: workflowTestSuiteAcceptedSchema,
    WorkflowTestSuiteList: workflowTestSuiteListSchema,
    WorkflowTestSuiteDetail: workflowTestSuiteDetailSchema,
    WorkflowTestSuiteCaseReport: workflowTestSuiteCaseReportSchema,
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
const root =
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/test-suites';
const scope = [
  uuidPathParameter('workspaceId', 'Workspace identifier'),
  uuidPathParameter('workflowId', 'Workflow identifier'),
];
const suite = uuidPathParameter('suiteId', 'Retained test suite identifier');
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '422': responseReference('UnprocessableEntity'),
  '429': problemResponse('Rate limited'),
  '500': responseReference('Unexpected'),
};
export const workflowTestSuitePaths = {
  [`${root}/prepare`]: {
    get: {
      operationId: 'prepareWorkflowTestSuite',
      security: [{ cookieSession: [] }],
      parameters: scope,
      responses: {
        '200': jsonResponse(
          'Saved draft, pins, case revisions and one effects disclosure',
          'WorkflowTestSuitePreparation',
        ),
        ...errors,
      },
    },
  },
  [root]: {
    get: {
      operationId: 'listWorkflowTestSuites',
      security: [{ cookieSession: [] }],
      parameters: scope,
      responses: {
        '200': jsonResponse(
          'Twenty recent suites and current metadata freshness; no case values',
          'WorkflowTestSuiteList',
        ),
        ...errors,
      },
    },
    post: {
      operationId: 'startWorkflowTestSuite',
      security: [{ cookieSession: [] }],
      parameters: [
        ...scope,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('WorkflowTestSuiteStartRequest'),
      responses: {
        '202': jsonResponse(
          'Frozen suite and its first test accepted atomically',
          'WorkflowTestSuiteAccepted',
        ),
        ...errors,
      },
    },
  },
  [`${root}/{suiteId}`]: {
    get: {
      operationId: 'getWorkflowTestSuite',
      security: [{ cookieSession: [] }],
      parameters: [...scope, suite],
      responses: {
        '200': jsonResponse(
          'Serial case statuses without case inputs or reports',
          'WorkflowTestSuiteDetail',
        ),
        ...errors,
      },
    },
  },
  [`${root}/{suiteId}/cases/{ordinal}`]: {
    get: {
      operationId: 'getWorkflowTestSuiteCaseReport',
      security: [{ cookieSession: [] }],
      parameters: [
        ...scope,
        suite,
        {
          in: 'path',
          name: 'ordinal',
          required: true,
          description: 'Zero-based case position',
          schema: { type: 'integer', minimum: 0, maximum: 49 },
        },
      ],
      responses: {
        '200': jsonResponse(
          'One bounded private expected/actual report',
          'WorkflowTestSuiteCaseReport',
        ),
        ...errors,
      },
    },
  },
  [`${root}/{suiteId}/cancel`]: {
    post: {
      operationId: 'cancelWorkflowTestSuite',
      security: [{ cookieSession: [] }],
      parameters: [...scope, suite, csrfHeaderParameter()],
      requestBody: jsonRequest('WorkflowTestCancelRequest'),
      responses: {
        '200': jsonResponse(
          'Future cases stopped and current test cancellation requested',
          'WorkflowTestCancelResponse',
        ),
        ...errors,
      },
    },
  },
};
