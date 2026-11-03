import { apiProblemSchema } from '../../errors/api-problem.js';
import {
  workflowTestRoutes,
  workflowTestSuiteRoutes,
} from '../../routes/execution/draft-tests.js';
import {
  nodeTestingRoutes,
  stepSampleRoutes,
} from '../../routes/execution/node-testing.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { nodeSideEffectDisclosureSchema } from '../../schemas/execution/node-testing.js';
import { authenticatedComponents, problemResponse } from '../primitives.js';
import { projectContractSchema } from '../schema-projection.js';

const routes = [
  ...Object.values(stepSampleRoutes),
  ...Object.values(workflowTestRoutes),
  ...Object.values(workflowTestSuiteRoutes),
  ...Object.values(nodeTestingRoutes),
];

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  UnprocessableEntity: problemResponse('Node test input is not executable'),
  Unexpected: problemResponse('Unexpected server error'),
});

export const nodeTestingOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Node Testing API', version: '1.0.0' },
  paths: routePaths(routes),
  components: authenticatedComponents(
    {
      ...routeSchemas(routes),
      ApiProblem: projectContractSchema(
        'ApiProblem',
        apiProblemSchema,
        'output',
      ),
      NodeSideEffectDisclosure: projectContractSchema(
        'NodeSideEffectDisclosure',
        nodeSideEffectDisclosureSchema,
        'output',
      ),
    },
    problemResponses,
  ),
});
