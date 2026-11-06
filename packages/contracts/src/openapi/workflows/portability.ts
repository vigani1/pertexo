import { sharedProblemResponses } from '../problem-responses.js';
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
      BadRequest: sharedProblemResponses.BadRequest,
      Unauthenticated: sharedProblemResponses.Unauthenticated,
      Forbidden: sharedProblemResponses.Forbidden,
      NotFound: sharedProblemResponses.NotFound,
      Conflict: problemResponse(
        'Source, compatibility or idempotency conflict',
      ),
      UnprocessableEntity: problemResponse('Unsafe or incompatible workflow'),
      Unexpected: sharedProblemResponses.Unexpected,
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
