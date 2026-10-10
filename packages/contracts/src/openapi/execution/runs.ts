import {
  authenticatedComponents,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  responseReference,
  uuidPathParameter as pathParameter,
} from '../primitives.js';

import { apiProblemSchema } from '../../errors/api-problem.js';
import { projectContractSchema } from '../schema-projection.js';
import {
  lastRunEventIdHeaderSchema,
  workflowRunCreatedAtSchema,
  workflowRunCursorSchema,
  workflowRunListResponseSchema,
  workflowRunListQuerySchema,
  workflowRunPageLimitSchema,
  workflowRunStatusSchema,
  workflowNodeRunSummarySchema,
  workflowRunCancelRequestSchema,
  workflowRunCancelResponseSchema,
  workflowRunEventSchema,
  workflowRunResponseSchema,
  workflowRunReplayRequestSchema,
  workflowRunStartRequestSchema,
  workflowRunStartParamsSchema,
  workflowRunStartResponseSchema,
  workflowRunStatisticsBreakdownSchema,
  workflowRunStatisticsResponseSchema,
  usageCapacityResponseSchema,
  workflowRunStatisticsWindowSchema,
  workflowRunSummarySchema,
  workflowRunReadSummarySchema,
  workflowRunListItemSchema,
  workflowRunInputResponseSchema,
  workflowNodeRunOutputResponseSchema,
  workflowNodeRunInputResponseSchema,
  workflowStepHealthResponseSchema,
  workflowStepRunsResponseSchema,
  workflowStepRunsQuerySchema,
} from '../../schemas/execution/runs.js';

const schemas = Object.freeze({
  UsageCapacityResponse: jsonSchema(usageCapacityResponseSchema, 'output'),
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  WorkflowRunStartRequest: jsonSchema(workflowRunStartRequestSchema, 'input'),
  WorkflowRunReplayRequest: jsonSchema(workflowRunReplayRequestSchema, 'input'),
  WorkflowRunStartResponse: jsonSchema(
    workflowRunStartResponseSchema,
    'output',
  ),
  WorkflowRunSummary: jsonSchema(workflowRunSummarySchema, 'output'),
  WorkflowRunReadSummary: jsonSchema(workflowRunReadSummarySchema, 'output'),
  WorkflowRunListItem: jsonSchema(workflowRunListItemSchema, 'output'),
  WorkflowRunListResponse: jsonSchema(workflowRunListResponseSchema, 'output'),
  WorkflowRunStatisticsResponse: jsonSchema(
    workflowRunStatisticsResponseSchema,
    'output',
  ),
  WorkflowNodeRunSummary: jsonSchema(workflowNodeRunSummarySchema, 'output'),
  WorkflowRunResponse: jsonSchema(workflowRunResponseSchema, 'output'),
  WorkflowRunCancelRequest: jsonSchema(workflowRunCancelRequestSchema, 'input'),
  WorkflowRunCancelResponse: jsonSchema(
    workflowRunCancelResponseSchema,
    'output',
  ),
  WorkflowRunEvent: jsonSchema(workflowRunEventSchema, 'output'),
  WorkflowStepHealthResponse: jsonSchema(
    workflowStepHealthResponseSchema,
    'output',
  ),
  WorkflowStepRunsResponse: jsonSchema(
    workflowStepRunsResponseSchema,
    'output',
  ),
});

/** Stored run data is recursive JSON, which needs the shared projection. */
function runDataSchemas(target: 'client' | 'openapi') {
  return Object.freeze({
    WorkflowRunInputResponse: projectContractSchema(
      'WorkflowRunInputResponse',
      workflowRunInputResponseSchema,
      'output',
      target,
    ),
    WorkflowNodeRunOutputResponse: projectContractSchema(
      'WorkflowNodeRunOutputResponse',
      workflowNodeRunOutputResponseSchema,
      'output',
      target,
    ),
    WorkflowNodeRunInputResponse: projectContractSchema(
      'WorkflowNodeRunInputResponse',
      workflowNodeRunInputResponseSchema,
      'output',
      target,
    ),
  });
}

export const workflowRunsClientContract = Object.freeze({
  schemas: Object.freeze({ ...schemas, ...runDataSchemas('client') }),
});

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  UnprocessableEntity: problemResponse('Workflow is not executable'),
  Unexpected: problemResponse('Unexpected server error'),
});

const workspaceParameter = pathParameter('workspaceId', 'Workspace identifier');
const workflowParameter = pathParameter('workflowId', 'Workflow identifier');
const runParameter = pathParameter('runId', 'Workflow run identifier');
const nodeRunParameter = pathParameter('nodeRunId', 'Node run identifier');
const stepParameter = {
  name: 'nodeId',
  in: 'path',
  required: true,
  description: 'Step (node) identifier in the workflow graph',
  schema: { type: 'string', minLength: 1, maxLength: 256 },
} as const;
const csrfParameter = csrfHeaderParameter();
const idempotencyParameter = idempotencyHeaderParameter();
const lastEventIdParameter = {
  name: 'Last-Event-ID',
  in: 'header',
  required: false,
  schema: jsonSchema(lastRunEventIdHeaderSchema, 'input'),
} as const;
const queryParameter = (
  name: string,
  schema: Parameters<typeof jsonSchema>[0],
) =>
  ({
    name,
    in: 'query',
    required: false,
    schema: jsonSchema(schema, 'input'),
  }) as const;

export const workflowRunsOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Workflow Runs API', version: '1.0.0' },
  paths: {
    '/v1/workspaces/{workspaceId}/usage-capacity': {
      get: {
        operationId: 'getWorkspaceUsageCapacity',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter],
        responses: {
          '200': jsonResponse(
            'Current operational capacity; not billing',
            'UsageCapacityResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs': {
      get: {
        operationId: 'listWorkflowRuns',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          queryParameter('limit', workflowRunPageLimitSchema),
          queryParameter('after', workflowRunCursorSchema),
          queryParameter(
            'workflowId',
            workflowRunStartParamsSchema.shape.workflowId,
          ),
          queryParameter(
            'workflowNamePrefix',
            workflowRunListQuerySchema.shape.workflowNamePrefix,
          ),
          queryParameter('status', workflowRunStatusSchema),
          queryParameter('createdAtFrom', workflowRunCreatedAtSchema),
          queryParameter('createdAtBefore', workflowRunCreatedAtSchema),
        ],
        responses: {
          '200': jsonResponse('Workflow runs', 'WorkflowRunListResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/run-statistics': {
      get: {
        operationId: 'getWorkflowRunStatistics',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          queryParameter('window', workflowRunStatisticsWindowSchema),
          queryParameter('breakdown', workflowRunStatisticsBreakdownSchema),
        ],
        responses: {
          '200': jsonResponse(
            'Exact run counts for one snapshot',
            'WorkflowRunStatisticsResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/runs': {
      post: {
        operationId: 'startWorkflowRun',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          workflowParameter,
          csrfParameter,
          idempotencyParameter,
        ],
        requestBody: jsonRequest('WorkflowRunStartRequest'),
        responses: {
          '202': jsonResponse(
            'Workflow run accepted',
            'WorkflowRunStartResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '422': responseReference('UnprocessableEntity'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs/{runId}': {
      get: {
        operationId: 'getWorkflowRun',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, runParameter],
        responses: {
          '200': jsonResponse('Workflow run', 'WorkflowRunResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs/{runId}/input': {
      get: {
        operationId: 'getWorkflowRunInput',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, runParameter],
        responses: {
          '200': jsonResponse(
            'The input the run started with',
            'WorkflowRunInputResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs/{runId}/node-runs/{nodeRunId}/output': {
      get: {
        operationId: 'getWorkflowNodeRunOutput',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, runParameter, nodeRunParameter],
        responses: {
          '200': jsonResponse(
            'The output one step run produced',
            'WorkflowNodeRunOutputResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs/{runId}/node-runs/{nodeRunId}/input': {
      get: {
        operationId: 'getWorkflowNodeRunInput',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, runParameter, nodeRunParameter],
        responses: {
          '200': jsonResponse(
            'The input one step run received, when it was recorded',
            'WorkflowNodeRunInputResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/step-health': {
      get: {
        operationId: 'getWorkflowStepHealth',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, workflowParameter],
        responses: {
          '200': jsonResponse(
            'Each step across the workflow’s last 100 runs',
            'WorkflowStepHealthResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/steps/{nodeId}/runs': {
      get: {
        operationId: 'listWorkflowStepRuns',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          workflowParameter,
          stepParameter,
          queryParameter('limit', workflowStepRunsQuerySchema.shape.limit),
        ],
        responses: {
          '200': jsonResponse(
            'One step’s runs in the workflow’s last 100 runs',
            'WorkflowStepRunsResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs/{runId}/events': {
      get: {
        operationId: 'streamRunEvents',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, runParameter, lastEventIdParameter],
        responses: {
          '200': {
            description: 'Ordered workflow run event stream',
            content: {
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description: 'SSE frames containing WorkflowRunEvent data',
                },
              },
            },
          },
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs/{runId}/cancel': {
      post: {
        operationId: 'cancelWorkflowRun',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, runParameter, csrfParameter],
        requestBody: jsonRequest('WorkflowRunCancelRequest'),
        responses: {
          '200': jsonResponse(
            'Workflow run cancellation requested',
            'WorkflowRunCancelResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs/{runId}/replay': {
      post: {
        operationId: 'replayWorkflowRun',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          runParameter,
          csrfParameter,
          idempotencyParameter,
        ],
        requestBody: jsonRequest('WorkflowRunReplayRequest'),
        responses: {
          '202': jsonResponse(
            'Workflow run replay accepted',
            'WorkflowRunStartResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '422': responseReference('UnprocessableEntity'),
          '500': responseReference('Unexpected'),
        },
      },
    },
  },
  components: authenticatedComponents(
    { ...schemas, ...runDataSchemas('openapi') },
    problemResponses,
  ),
});
