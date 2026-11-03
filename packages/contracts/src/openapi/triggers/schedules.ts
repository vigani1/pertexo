import { apiProblemSchema } from '../../errors/api-problem.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { scheduleRoutes } from '../../routes/triggers/schedules.js';
import {
  authenticatedComponents,
  jsonSchema,
  problemResponse,
} from '../primitives.js';

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
      BadRequest: problemResponse('Invalid request'),
      Unauthenticated: problemResponse('Authentication required'),
      Forbidden: problemResponse('Forbidden'),
      NotFound: problemResponse('Resource not found'),
      Conflict: problemResponse('Request conflict'),
      RateLimited: problemResponse('Rate limited'),
      Unexpected: problemResponse('Unexpected server error'),
    },
  ),
  paths: routePaths(routes),
});
