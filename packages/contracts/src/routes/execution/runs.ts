import {
  ACTIVE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { z } from 'zod';

import { problemResponse } from '../openapi-primitives.js';
import {
  lastRunEventIdHeaderSchema,
  workflowRunCancelRequestSchema,
  workflowRunCancelResponseSchema,
  workflowRunListParamsSchema,
  workflowRunListQuerySchema,
  workflowRunListResponseSchema,
  workflowRunParamsSchema,
  workflowRunReplayRequestSchema,
  workflowRunResponseSchema,
  workflowRunStartParamsSchema,
  workflowRunStartRequestSchema,
  workflowRunStartResponseSchema,
  workflowRunStatisticsQuerySchema,
  workflowRunStatisticsResponseSchema,
} from '../../schemas/execution/runs.js';
import {
  workflowRecoveryPreviewSchema,
  workflowRecoveryRequestSchema,
} from '../../schemas/execution/recovery.js';
import { defineRoute, named } from '../define.js';
import {
  capability,
  problems,
  read,
  replay,
  RUN,
  session,
  sessionOrToken,
  tokenProblems,
  WORKSPACE,
} from './run-access.js';

const accepted = named(
  'WorkflowRunStartResponse',
  workflowRunStartResponseSchema,
);

export const workflowRunRoutes = {
  list: defineRoute({
    operationId: 'listWorkflowRuns',
    method: 'get',
    path: `${WORKSPACE}/runs`,
    params: workflowRunListParamsSchema,
    query: workflowRunListQuerySchema,
    access: sessionOrToken(read),
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Workflow runs',
      body: named('WorkflowRunListResponse', workflowRunListResponseSchema),
    },
    problems: {
      ...tokenProblems,
      ...problems('400', '401', '403', '404', '500'),
    },
  }),
  statistics: defineRoute({
    operationId: 'getWorkflowRunStatistics',
    method: 'get',
    path: `${WORKSPACE}/run-statistics`,
    params: workflowRunListParamsSchema,
    query: workflowRunStatisticsQuerySchema,
    access: session(read),
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Exact run counts for one snapshot',
      body: named(
        'WorkflowRunStatisticsResponse',
        workflowRunStatisticsResponseSchema,
      ),
    },
    problems: problems('400', '401', '403', '404', '500'),
  }),
  start: defineRoute({
    operationId: 'startWorkflowRun',
    method: 'post',
    path: `${WORKSPACE}/workflows/{workflowId}/runs`,
    params: workflowRunStartParamsSchema,
    access: sessionOrToken(capability('run:start', ACTIVE_WORKSPACE_STATUSES)),
    rateLimit: 'run_admission',
    idempotent: true,
    // No body runs the current version with its default input.
    body: named(
      'WorkflowRunStartRequest',
      workflowRunStartRequestSchema.default({}),
    ),
    success: {
      status: 202,
      description: 'Workflow run accepted',
      body: accepted,
    },
    problems: {
      ...tokenProblems,
      ...problems('400', '401', '403', '404', '409', '422', '500'),
    },
  }),
  get: defineRoute({
    operationId: 'getWorkflowRun',
    method: 'get',
    path: RUN,
    params: workflowRunParamsSchema,
    access: sessionOrToken(read),
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Workflow run',
      body: named('WorkflowRunResponse', workflowRunResponseSchema),
    },
    problems: {
      ...tokenProblems,
      ...problems('400', '401', '403', '404', '500'),
    },
  }),
  events: defineRoute({
    operationId: 'streamRunEvents',
    method: 'get',
    path: `${RUN}/events`,
    params: workflowRunParamsSchema,
    headers: z.object({
      'last-event-id': lastRunEventIdHeaderSchema.optional(),
    }),
    access: session(read),
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      response: {
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
    },
    problems: problems('400', '401', '403', '404', '500'),
  }),
  cancel: defineRoute({
    operationId: 'cancelWorkflowRun',
    method: 'post',
    path: `${RUN}/cancel`,
    params: workflowRunParamsSchema,
    access: sessionOrToken(
      capability('run:cancel', UNPURGED_WORKSPACE_STATUSES),
    ),
    rateLimit: 'ordinary_mutation',
    body: named(
      'WorkflowRunCancelRequest',
      workflowRunCancelRequestSchema.default({}),
    ),
    success: {
      status: 200,
      description: 'Workflow run cancellation requested',
      body: named('WorkflowRunCancelResponse', workflowRunCancelResponseSchema),
    },
    problems: {
      ...tokenProblems,
      ...problems('400', '401', '403', '404', '409', '500'),
    },
  }),
  replay: defineRoute({
    operationId: 'replayWorkflowRun',
    method: 'post',
    path: `${RUN}/replay`,
    params: workflowRunParamsSchema,
    access: session(replay),
    rateLimit: 'run_admission',
    idempotent: true,
    body: named('WorkflowRunReplayRequest', workflowRunReplayRequestSchema),
    success: {
      status: 202,
      description: 'Workflow run replay accepted',
      body: accepted,
    },
    problems: problems('400', '401', '403', '404', '409', '422', '500'),
  }),
  recovery: defineRoute({
    operationId: 'getWorkflowRunRecovery',
    method: 'get',
    path: `${RUN}/recovery`,
    params: workflowRunParamsSchema,
    access: session(replay),
    rateLimit: 'authenticated_read',
    description:
      'Requires run:replay in an active workspace. Bounded metadata preview; acceptance rechecks eligibility. No stored values are disclosed.',
    success: {
      status: 200,
      description: 'Current recovery eligibility',
      body: named('WorkflowRecoveryPreview', workflowRecoveryPreviewSchema),
    },
    problems: problems('401', '404', '409', '500'),
  }),
  recover: defineRoute({
    operationId: 'recoverWorkflowRun',
    method: 'post',
    path: `${RUN}/recover`,
    params: workflowRunParamsSchema,
    access: session(replay),
    rateLimit: 'run_admission',
    idempotent: true,
    description:
      'New run of the exact source version and input; completed steps are owned copies with no attempts. Possible effects require explicit acknowledgement. An unknown target requires separate acknowledgeUnknownOutcome; possible-effects acknowledgement alone is refused. Unknown outcomes outside the target remain refused. Exact retries use the retained 24-hour command key and current authority.',
    body: named('WorkflowRecoveryRequest', workflowRecoveryRequestSchema),
    success: {
      status: 202,
      description: 'Recovery run accepted',
      body: accepted,
    },
    problems: {
      ...problems('400', '401', '403', '404'),
      '409': {
        description: 'Recovery unavailable or command conflict',
        content: {
          'application/problem+json': {
            schema: {
              oneOf: [
                {
                  $ref: '#/components/schemas/WorkflowRecoveryUnavailableProblem',
                },
                { $ref: '#/components/schemas/ApiProblem' },
              ],
            },
          },
        },
      },
      '429': problemResponse('Rate or queued-run limit reached'),
      ...problems('500'),
    },
  }),
};
