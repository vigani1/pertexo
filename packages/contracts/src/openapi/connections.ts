import { sharedProblemResponses } from './problem-responses.js';
import { apiProblemSchema } from '../errors/api-problem.js';
import { failureNotificationRoutes } from '../routes/connections/failure-notifications.js';
import { connectionRoutes } from '../routes/connections/management.js';
import { routePaths, routeSchemas } from '../routes/openapi.js';
import {
  OAUTH2_CALLBACK_PATH,
  OAUTH2_LANDING_PATH,
  oauth2CallbackCodeSchema,
  oauth2CallbackErrorSchema,
  oauth2CallbackLandingSchema,
  oauth2CallbackQuerySchema,
  oauth2CallbackStateSchema,
  oauth2ClientSettingsSchema,
  oauth2ConnectionErrorCodeSchema,
  oauth2ConnectionResponseSchema,
  oauth2CredentialSchema,
  oauth2StepFailureCodeSchema,
} from '../schemas/oauth2-connections.js';
import {
  authenticatedComponents,
  jsonSchema,
  problemResponse,
  queryParameter,
  responseReference,
} from '../routes/openapi-primitives.js';

const { slackChannels, ...beforeCallback } = connectionRoutes;
const routes = [
  ...Object.values(beforeCallback),
  slackChannels,
  ...Object.values(failureNotificationRoutes),
];

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  ...routeSchemas(routes),
  // Documented for clients that read stored connections and the callback landing.
  OAuth2ClientSettings: jsonSchema(oauth2ClientSettingsSchema, 'output'),
  OAuth2Credential: jsonSchema(oauth2CredentialSchema, 'input'),
  OAuth2Connection: jsonSchema(oauth2ConnectionResponseSchema, 'output'),
  OAuth2ConnectionErrorCode: jsonSchema(
    oauth2ConnectionErrorCodeSchema,
    'output',
  ),
  OAuth2StepFailureCode: jsonSchema(oauth2StepFailureCodeSchema, 'output'),
  OAuth2CallbackQuery: jsonSchema(oauth2CallbackQuerySchema, 'input'),
  OAuth2CallbackLanding: jsonSchema(oauth2CallbackLandingSchema, 'output'),
});

const problemResponses = Object.freeze({
  BadRequest: sharedProblemResponses.BadRequest,
  Unauthenticated: sharedProblemResponses.Unauthenticated,
  Forbidden: sharedProblemResponses.Forbidden,
  NotFound: sharedProblemResponses.NotFound,
  Conflict: sharedProblemResponses.Conflict,
  ReauthorizationRequired: problemResponse('Reauthorization required'),
  RateLimited: sharedProblemResponses.RateLimited,
  ConnectionServiceUnavailable: problemResponse(
    'Key or provider service unavailable',
  ),
  Unexpected: sharedProblemResponses.Unexpected,
});

export const connectionsOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Connections API', version: '1.4.0' },
  paths: {
    ...routePaths(Object.values(beforeCallback)),
    // Public and always a redirect: its use case reads the query to pick the landing.
    [OAUTH2_CALLBACK_PATH]: {
      get: {
        operationId: 'completeConnectionOAuth2Authorization',
        description:
          'Where a provider returns the browser. The single-use state and its browser binding cookie stand in for the session and CSRF token. Every outcome is a redirect to the web landing page; its query follows OAuth2CallbackLanding. The accepted query is OAuth2CallbackQuery.',
        security: [],
        parameters: [
          queryParameter('state', oauth2CallbackStateSchema, {
            required: true,
          }),
          queryParameter('code', oauth2CallbackCodeSchema),
          queryParameter('error', oauth2CallbackErrorSchema),
        ],
        responses: {
          '303': { description: `Redirect to ${OAUTH2_LANDING_PATH}` },
          '429': responseReference('RateLimited'),
        },
      },
    },
    ...routePaths([slackChannels, ...Object.values(failureNotificationRoutes)]),
  },
  components: authenticatedComponents(schemas, problemResponses, {
    automation: true,
  }),
});
