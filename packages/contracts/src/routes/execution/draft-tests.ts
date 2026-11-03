import {
  problemResponse,
  responseReference,
} from '../../openapi/primitives.js';
import {
  workflowTestSuiteAcceptedSchema,
  workflowTestSuiteCaseParamsSchema,
  workflowTestSuiteCaseReportSchema,
  workflowTestSuiteDetailSchema,
  workflowTestSuiteListSchema,
  workflowTestSuiteParamsSchema,
  workflowTestSuitePreparationSchema,
  workflowTestSuiteStartRequestSchema,
} from '../../schemas/execution/test-suites.js';
import {
  workflowTestAcceptedSchema,
  workflowTestCancelRequestSchema,
  workflowTestCancelResponseSchema,
  workflowTestDetailSchema,
  workflowTestListSchema,
  workflowTestParamsSchema,
  workflowTestPreparationSchema,
  workflowTestStartRequestSchema,
} from '../../schemas/execution/workflow-tests.js';
import { workflowIdParamSchema } from '../../schemas/workflows/authoring.js';
import { defineRoute, named } from '../define.js';
import { updatingDraft as access } from './node-testing.js';

const TESTS = '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/tests';
const SUITES =
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/test-suites';
const problems = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '422': responseReference('UnprocessableEntity'),
  '500': responseReference('Unexpected'),
};
const suiteProblems = { ...problems, '429': problemResponse('Rate limited') };
const projected = { projected: true } as const;
const noStore = 'private, no-store';
const cancelRequest = named(
  'WorkflowTestCancelRequest',
  workflowTestCancelRequestSchema,
  projected,
);
const canceled = named(
  'WorkflowTestCancelResponse',
  workflowTestCancelResponseSchema,
  projected,
);

export const workflowTestRoutes = {
  prepare: defineRoute({
    operationId: 'prepareWorkflowTest',
    method: 'get',
    path: `${TESTS}/prepare`,
    params: workflowIdParamSchema,
    access,
    rateLimit: 'workflow_compile',
    cacheControl: noStore,
    success: {
      status: 200,
      description:
        'Exact saved draft, matching pins and unpinned effectful steps',
      body: named(
        'WorkflowTestPreparation',
        workflowTestPreparationSchema,
        projected,
      ),
    },
    problems,
  }),
  list: defineRoute({
    operationId: 'listWorkflowTests',
    method: 'get',
    path: TESTS,
    params: workflowIdParamSchema,
    access,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Retained editor test history; separate from real runs',
      body: named('WorkflowTestList', workflowTestListSchema, projected),
    },
    problems,
  }),
  start: defineRoute({
    operationId: 'startWorkflowTest',
    method: 'post',
    path: TESTS,
    params: workflowIdParamSchema,
    access,
    rateLimit: 'preview_test',
    idempotent: true,
    body: named(
      'WorkflowTestStartRequest',
      workflowTestStartRequestSchema,
      projected,
    ),
    success: {
      status: 202,
      description:
        'Saved draft accepted as a test; unpinned effectful steps require acknowledgement',
      body: named(
        'WorkflowTestAccepted',
        workflowTestAcceptedSchema,
        projected,
      ),
    },
    problems,
  }),
  get: defineRoute({
    operationId: 'getWorkflowTest',
    method: 'get',
    path: `${TESTS}/{runId}`,
    params: workflowTestParamsSchema,
    access,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description:
        'Immutable test graph and substitution provenance; use run events for progress and scoped step reads for output',
      body: named('WorkflowTestDetail', workflowTestDetailSchema, projected),
    },
    problems,
  }),
  cancel: defineRoute({
    operationId: 'cancelWorkflowTest',
    method: 'post',
    path: `${TESTS}/{runId}/cancel`,
    params: workflowTestParamsSchema,
    access,
    rateLimit: 'ordinary_mutation',
    body: cancelRequest,
    success: {
      status: 200,
      description:
        'Cancellation requested idempotently; already settled tests remain settled',
      body: canceled,
    },
    problems,
  }),
};

export const workflowTestSuiteRoutes = {
  prepare: defineRoute({
    operationId: 'prepareWorkflowTestSuite',
    method: 'get',
    path: `${SUITES}/prepare`,
    params: workflowIdParamSchema,
    access,
    rateLimit: 'workflow_compile',
    cacheControl: noStore,
    success: {
      status: 200,
      description:
        'Saved draft, pins, case revisions and one effects disclosure',
      body: named(
        'WorkflowTestSuitePreparation',
        workflowTestSuitePreparationSchema,
        projected,
      ),
    },
    problems: suiteProblems,
  }),
  list: defineRoute({
    operationId: 'listWorkflowTestSuites',
    method: 'get',
    path: SUITES,
    params: workflowIdParamSchema,
    access,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description:
        'Twenty recent suites and current metadata freshness; no case values',
      body: named(
        'WorkflowTestSuiteList',
        workflowTestSuiteListSchema,
        projected,
      ),
    },
    problems: suiteProblems,
  }),
  start: defineRoute({
    operationId: 'startWorkflowTestSuite',
    method: 'post',
    path: SUITES,
    params: workflowIdParamSchema,
    access,
    rateLimit: 'preview_test',
    idempotent: true,
    body: named(
      'WorkflowTestSuiteStartRequest',
      workflowTestSuiteStartRequestSchema,
      projected,
    ),
    success: {
      status: 202,
      description: 'Frozen suite and its first test accepted atomically',
      body: named(
        'WorkflowTestSuiteAccepted',
        workflowTestSuiteAcceptedSchema,
        projected,
      ),
    },
    problems: suiteProblems,
  }),
  get: defineRoute({
    operationId: 'getWorkflowTestSuite',
    method: 'get',
    path: `${SUITES}/{suiteId}`,
    params: workflowTestSuiteParamsSchema,
    access,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Serial case statuses without case inputs or reports',
      body: named(
        'WorkflowTestSuiteDetail',
        workflowTestSuiteDetailSchema,
        projected,
      ),
    },
    problems: suiteProblems,
  }),
  report: defineRoute({
    operationId: 'getWorkflowTestSuiteCaseReport',
    method: 'get',
    path: `${SUITES}/{suiteId}/cases/{ordinal}`,
    params: workflowTestSuiteCaseParamsSchema,
    access,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'One bounded private expected/actual report',
      body: named(
        'WorkflowTestSuiteCaseReport',
        workflowTestSuiteCaseReportSchema,
        projected,
      ),
    },
    problems: suiteProblems,
  }),
  cancel: defineRoute({
    operationId: 'cancelWorkflowTestSuite',
    method: 'post',
    path: `${SUITES}/{suiteId}/cancel`,
    params: workflowTestSuiteParamsSchema,
    access,
    rateLimit: 'ordinary_mutation',
    body: cancelRequest,
    success: {
      status: 200,
      description:
        'Future cases stopped and current test cancellation requested',
      body: canceled,
    },
    problems: suiteProblems,
  }),
};
