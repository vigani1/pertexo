import { sharedProblemResponses } from './problem-responses.js';
import { apiProblemSchema } from '../errors/api-problem.js';
import { catalogRoutes } from '../routes/catalog.js';
import { routePaths, routeSchemas } from '../routes/openapi.js';
import {
  authenticatedComponents,
  problemResponse,
} from '../routes/openapi-primitives.js';
import { projectContractSchema } from '../routes/schema-projection.js';

const routes = Object.values(catalogRoutes);

export const catalogOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Catalog API', version: '1.0.0' },
  paths: routePaths(routes),
  components: authenticatedComponents(
    {
      ApiProblem: projectContractSchema(
        'ApiProblem',
        apiProblemSchema,
        'output',
      ),
      ...routeSchemas(routes),
    },
    {
      CatalogBadRequest: problemResponse('Invalid discovery query'),
      Unauthenticated: sharedProblemResponses.Unauthenticated,
      RateLimited: sharedProblemResponses.RateLimited,
      Unexpected: sharedProblemResponses.Unexpected,
    },
  ),
});
