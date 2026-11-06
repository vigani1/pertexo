import { sharedProblemResponses } from '../problem-responses.js';
import { apiProblemSchema } from '../../errors/api-problem.js';
import { artifactRoutes } from '../../routes/execution/artifacts.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import {
  authenticatedComponents,
  jsonSchema,
  problemResponse,
} from '../primitives.js';

const routes = Object.values(artifactRoutes);

export const artifactTransferOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Artifacts API', version: '1.0.0' },
  components: authenticatedComponents(
    {
      ApiProblem: jsonSchema(apiProblemSchema, 'output'),
      ...routeSchemas(routes),
    },
    {
      BadRequest: problemResponse('Invalid artifact request'),
      Unauthenticated: sharedProblemResponses.Unauthenticated,
      Forbidden: problemResponse('CSRF protection failed'),
      NotFound: problemResponse('Artifact or workspace not found'),
      Conflict: problemResponse(
        'Artifact lifecycle, metadata or idempotency conflict',
      ),
      TooLarge: problemResponse(
        'File exceeds 10 MB or the configured lower storage limit',
      ),
      QuotaExceeded: problemResponse('Workspace artifact capacity exceeded'),
      Unavailable: problemResponse('Artifact storage is unavailable'),
      Unexpected: sharedProblemResponses.Unexpected,
    },
  ),
  paths: routePaths(routes),
});
