import { sharedProblemResponses } from '../problem-responses.js';
import {
  notificationPreferencePaths,
  notificationPreferenceSchemas,
} from './notification-preferences.js';
import { apiProblemSchema } from '../../errors/api-problem.js';
import { workspaceInboxStreamEventSchema } from '../../schemas/identity/inbox.js';
import { inboxRoutes } from '../../routes/identity/inbox.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import {
  authenticatedComponents,
  jsonSchema,
  problemResponse,
} from '../primitives.js';

const routes = Object.values(inboxRoutes);
const schemas = Object.freeze({
  ...notificationPreferenceSchemas,
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  ...routeSchemas(routes),
  // The hint stream's frames, which the stream's document names.
  WorkspaceInboxStreamEvent: jsonSchema(
    workspaceInboxStreamEventSchema,
    'output',
  ),
});
const responses = Object.freeze({
  BadRequest: sharedProblemResponses.BadRequest,
  Unauthenticated: sharedProblemResponses.Unauthenticated,
  Forbidden: sharedProblemResponses.Forbidden,
  InboxNotFound: problemResponse('Inbox or thread unavailable'),
  RateLimited: sharedProblemResponses.RateLimited,
  Unexpected: sharedProblemResponses.Unexpected,
});

/** ADR 055: failure threads read on demand, with private read state. */
export const workspaceInboxOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Workspace Inbox API', version: '2.0.0' },
  components: authenticatedComponents(schemas, responses),
  paths: {
    ...notificationPreferencePaths,
    ...routePaths(routes),
  },
});
