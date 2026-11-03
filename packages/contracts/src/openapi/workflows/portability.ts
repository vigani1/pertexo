import { apiProblemSchema } from '../../errors/api-problem.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { portabilityRoutes } from '../../routes/workflows/portability.js';
import { authenticatedComponents, problemResponse } from '../primitives.js';
import { projectContractSchema } from '../schema-projection.js';

export const workflowPortabilityOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Workflow Portability API', version: '1.0.0' },
  paths: routePaths(Object.values(portabilityRoutes)),
  components: authenticatedComponents(
    {
      ...routeSchemas(Object.values(portabilityRoutes)),
      ApiProblem: projectContractSchema(
        'ApiProblem',
        apiProblemSchema,
        'output',
      ),
    },
    {
      BadRequest: problemResponse('Invalid request'),
      Unauthenticated: problemResponse('Authentication required'),
      Forbidden: problemResponse('Forbidden'),
      NotFound: problemResponse('Resource not found'),
      Conflict: problemResponse(
        'Source, compatibility or idempotency conflict',
      ),
      UnprocessableEntity: problemResponse('Unsafe or incompatible workflow'),
      Unexpected: problemResponse('Unexpected server error'),
      Unavailable: problemResponse(
        'Automation token authentication, limiter or import writer unavailable',
      ),
      PreconditionFailed: problemResponse('Saved draft changed'),
      PreconditionRequired: problemResponse('Draft If-Match required'),
      PayloadTooLarge: problemResponse('Request exceeds portable byte ceiling'),
    },
    { automation: true },
  ),
});
