import { sharedProblemResponses } from '../problem-responses.js';
import { apiProblemSchema } from '../../errors/api-problem.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { scheduleRoutes } from '../../routes/triggers/schedules.js';
import {
  authenticatedComponents,
  jsonSchema,
} from '../../routes/openapi-primitives.js';

const routes = Object.values(scheduleRoutes);

export const schedulesOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Schedules API', version: '1.0.0' },
  components: authenticatedComponents(
    {
      ApiProblem: jsonSchema(apiProblemSchema, 'output'),
      ...routeSchemas(routes),
    },
    {
      BadRequest: sharedProblemResponses.BadRequest,
      Unauthenticated: sharedProblemResponses.Unauthenticated,
      Forbidden: sharedProblemResponses.Forbidden,
      NotFound: sharedProblemResponses.NotFound,
      Conflict: sharedProblemResponses.Conflict,
      RateLimited: sharedProblemResponses.RateLimited,
      Unexpected: sharedProblemResponses.Unexpected,
    },
  ),
  paths: routePaths(routes),
});
