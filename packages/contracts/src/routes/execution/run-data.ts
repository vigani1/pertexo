import {
  workflowNodeRunDiagnosticsResponseSchema,
  workflowNodeRunInputResponseSchema,
  workflowNodeRunOutputResponseSchema,
  workflowNodeRunParamsSchema,
  workflowRunInputResponseSchema,
  workflowRunParamsSchema,
  workflowStepHealthResponseSchema,
  workflowStepRunsResponseSchema,
} from '../../schemas/execution/runs.js';
import {
  workflowStepHealthParamsSchema,
  workflowStepRunsParamsSchema,
  workflowStepRunsQuerySchema,
} from '../../schemas/execution/step-history.js';
import { workflowRunVariablesResponseSchema } from '../../schemas/identity/variables.js';
import { defineRoute, named } from '../define.js';
import {
  noStore,
  problems,
  rateLimited,
  read,
  readData,
  RUN,
  session,
  sessionOrToken,
  tokenProblems,
  WORKSPACE,
} from './run-access.js';

const NODE_RUN = `${RUN}/node-runs/{nodeRunId}` as const;
const runData = { projected: true } as const;

/** A run's recorded values (ADR 050) and each step across recent runs (ADR 051). */
export const workflowRunDataRoutes = {
  variables: defineRoute({
    operationId: 'getWorkflowRunVariables',
    method: 'get',
    path: `${RUN}/variables`,
    params: workflowRunParamsSchema,
    access: session(read),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description:
        'Retained run variable snapshot; null after logical detail expiry',
      body: named(
        'WorkflowRunVariablesResponse',
        workflowRunVariablesResponseSchema,
      ),
    },
    problems: { ...problems('401', '404'), ...rateLimited, ...problems('500') },
  }),
  input: defineRoute({
    operationId: 'getWorkflowRunInput',
    method: 'get',
    path: `${RUN}/input`,
    params: workflowRunParamsSchema,
    access: sessionOrToken(readData),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'The input the run started with',
      body: named(
        'WorkflowRunInputResponse',
        workflowRunInputResponseSchema,
        runData,
      ),
    },
    problems: {
      '429': tokenProblems['429'],
      ...problems('400', '401', '403', '404', '500'),
    },
  }),
  nodeOutput: defineRoute({
    operationId: 'getWorkflowNodeRunOutput',
    method: 'get',
    path: `${NODE_RUN}/output`,
    params: workflowNodeRunParamsSchema,
    access: sessionOrToken(readData),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'The output one step run produced',
      body: named(
        'WorkflowNodeRunOutputResponse',
        workflowNodeRunOutputResponseSchema,
        runData,
      ),
    },
    problems: {
      '429': tokenProblems['429'],
      ...problems('400', '401', '403', '404', '500'),
    },
  }),
  diagnostics: defineRoute({
    operationId: 'getWorkflowNodeRunDiagnostics',
    method: 'get',
    path: `${NODE_RUN}/diagnostics`,
    params: workflowNodeRunParamsSchema,
    access: session(read),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Private Code diagnostics for the current step attempt',
      body: named(
        'WorkflowNodeRunDiagnosticsResponse',
        workflowNodeRunDiagnosticsResponseSchema,
      ),
    },
    problems: problems('400', '401', '403', '404', '500'),
  }),
  nodeInput: defineRoute({
    operationId: 'getWorkflowNodeRunInput',
    method: 'get',
    path: `${NODE_RUN}/input`,
    params: workflowNodeRunParamsSchema,
    access: sessionOrToken(readData),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'The input one step run received, when it was recorded',
      body: named(
        'WorkflowNodeRunInputResponse',
        workflowNodeRunInputResponseSchema,
        runData,
      ),
    },
    problems: {
      '429': tokenProblems['429'],
      ...problems('400', '401', '403', '404', '500'),
    },
  }),
  stepHealth: defineRoute({
    operationId: 'getWorkflowStepHealth',
    method: 'get',
    path: `${WORKSPACE}/workflows/{workflowId}/step-health`,
    params: workflowStepHealthParamsSchema,
    access: session(read),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Each step across the workflow’s last 100 runs',
      body: named(
        'WorkflowStepHealthResponse',
        workflowStepHealthResponseSchema,
      ),
    },
    problems: problems('400', '401', '403', '404', '500'),
  }),
  stepRuns: defineRoute({
    operationId: 'listWorkflowStepRuns',
    method: 'get',
    path: `${WORKSPACE}/workflows/{workflowId}/steps/{nodeId}/runs`,
    params: workflowStepRunsParamsSchema,
    query: workflowStepRunsQuerySchema,
    access: session(read),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'One step’s runs in the workflow’s last 100 runs',
      body: named('WorkflowStepRunsResponse', workflowStepRunsResponseSchema),
    },
    problems: problems('400', '401', '403', '404', '500'),
  }),
};
