import { responseReference } from '../openapi/primitives.js';
import {
  catalogQuerySchema,
  integrationListResponseSchema,
  nodeDefinitionListResponseSchema,
} from '../schemas/catalog.js';
import { defineRoute, named } from './define.js';

const shared = {
  method: 'get',
  access: { auth: 'session' },
  rateLimit: 'authenticated_read',
  // Takes no query: anything sent is refused, so a typo can't look like a filter.
  query: catalogQuerySchema,
  problems: {
    '400': responseReference('BadRequest'),
    '401': responseReference('Unauthenticated'),
    '429': responseReference('RateLimited'),
    '500': responseReference('Unexpected'),
  },
} as const;

export const catalogRoutes = {
  nodeDefinitions: defineRoute({
    ...shared,
    operationId: 'listNodeDefinitions',
    path: '/v1/node-definitions',
    success: {
      status: 200,
      description: 'Available node definitions',
      body: named(
        'NodeDefinitionListResponse',
        nodeDefinitionListResponseSchema,
        { projected: true },
      ),
    },
  }),
  integrations: defineRoute({
    ...shared,
    operationId: 'listIntegrations',
    path: '/v1/integrations',
    success: {
      status: 200,
      description: 'Available integrations',
      body: named('IntegrationListResponse', integrationListResponseSchema, {
        projected: true,
      }),
    },
  }),
};
