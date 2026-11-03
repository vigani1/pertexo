import { formSchemas, formPaths } from './forms.js';
import { formUploadPaths, formUploadSchemas } from './form-uploads.js';
import { pendingTaskPaths, pendingTaskSchemas } from './pending-tasks.js';
import {
  authenticatedComponents,
  jsonSchema,
  problemResponse,
} from '../primitives.js';
import { apiProblemSchema } from '../../errors/api-problem.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { workflowRunRoutes } from '../../routes/execution/runs.js';
import { workflowRunDataRoutes } from '../../routes/execution/run-data.js';
import { usageRoutes } from '../../routes/execution/usage.js';
import {
  workflowNodeRunSummarySchema,
  workflowRecoveryUnavailableProblemSchema,
  workflowRunEventSchema,
  workflowRunListItemSchema,
  workflowRunReadSummarySchema,
  workflowRunSummarySchema,
} from '../../schemas/execution/runs.js';

const routes = [
  workflowRunDataRoutes.variables,
  usageRoutes.trends,
  usageRoutes.capacity,
  workflowRunRoutes.list,
  workflowRunRoutes.statistics,
  workflowRunRoutes.start,
  workflowRunRoutes.get,
  workflowRunDataRoutes.input,
  workflowRunDataRoutes.nodeOutput,
  workflowRunDataRoutes.diagnostics,
  workflowRunDataRoutes.nodeInput,
  workflowRunDataRoutes.stepHealth,
  workflowRunDataRoutes.stepRuns,
  workflowRunRoutes.events,
  workflowRunRoutes.cancel,
  workflowRunRoutes.recovery,
  workflowRunRoutes.recover,
  workflowRunRoutes.replay,
];

const schemas = Object.freeze({
  ...pendingTaskSchemas,
  ...formSchemas,
  ...formUploadSchemas,
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  ...routeSchemas(routes),
  // Shapes inside the answers, and the recovery refusal, named for clients.
  WorkflowRecoveryUnavailableProblem: jsonSchema(
    workflowRecoveryUnavailableProblemSchema,
    'output',
  ),
  WorkflowRunSummary: jsonSchema(workflowRunSummarySchema, 'output'),
  WorkflowRunReadSummary: jsonSchema(workflowRunReadSummarySchema, 'output'),
  WorkflowRunListItem: jsonSchema(workflowRunListItemSchema, 'output'),
  WorkflowNodeRunSummary: jsonSchema(workflowNodeRunSummarySchema, 'output'),
  WorkflowRunEvent: jsonSchema(workflowRunEventSchema, 'output'),
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

export const workflowRunsOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Workflow Runs API', version: '1.0.0' },
  paths: {
    ...pendingTaskPaths,
    ...formPaths,
    ...formUploadPaths,
    ...routePaths(routes),
  },
  components: authenticatedComponents(schemas, problemResponses, {
    automation: true,
  }),
});
