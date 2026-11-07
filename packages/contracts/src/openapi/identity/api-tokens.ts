import {
  apiTokenRoutes,
  noStoreHeader,
} from '../../routes/identity/api-tokens.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { apiTokenInfoResponseSchema } from '../../schemas/identity/api-tokens.js';
import { jsonResponse, jsonSchema, problemResponse } from '../../routes/openapi-primitives.js';

const routes = Object.values(apiTokenRoutes);

export const apiTokenContractSchemas = {
  ...routeSchemas(routes),
  ApiTokenInfoResponse: jsonSchema(apiTokenInfoResponseSchema, 'output'),
};
export const apiTokenContractPaths = {
  // A token reading itself: no session will do, which no declared access says.
  '/v1/token': {
    get: {
      operationId: 'readCurrentApiToken',
      description:
        'The calling token itself: its workspace, scopes and expiry. Secrets stay unavailable.',
      security: [{ apiToken: [] }],
      responses: {
        '200': {
          ...jsonResponse('This token', 'ApiTokenInfoResponse'),
          headers: noStoreHeader,
        },
        '401': problemResponse('Valid API token required'),
        '429': problemResponse('Rate limited'),
        '503': problemResponse('Automation tokens or rate limiter unavailable'),
        '500': problemResponse('Unexpected server error'),
      },
    },
  },
  ...routePaths(routes),
};
