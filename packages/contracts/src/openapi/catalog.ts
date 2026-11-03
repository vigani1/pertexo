import { apiProblemSchema } from '../errors/api-problem.js';
import {
  authenticatedComponents,
  jsonResponse,
  problemResponse,
  responseReference,
} from './primitives.js';
import {
  catalogQuerySchema,
  integrationListResponseSchema,
  nodeDefinitionListResponseSchema,
} from '../schemas/catalog.js';
import { projectContractSchema } from './schema-projection.js';

function contractSchemas() {
  return Object.freeze({
    CatalogQuery: projectContractSchema(
      'CatalogQuery',
      catalogQuerySchema,
      'input',
    ),
    ApiProblem: projectContractSchema('ApiProblem', apiProblemSchema, 'output'),
    NodeDefinitionListResponse: projectContractSchema(
      'NodeDefinitionListResponse',
      nodeDefinitionListResponseSchema,
      'output',
    ),
    IntegrationListResponse: projectContractSchema(
      'IntegrationListResponse',
      integrationListResponseSchema,
      'output',
    ),
  });
}

const openApiSchemas = contractSchemas();

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid discovery query'),
  Unauthenticated: problemResponse('Authentication required'),
  RateLimited: problemResponse('Rate limited'),
  Unexpected: problemResponse('Unexpected server error'),
});

export const catalogOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Catalog API', version: '1.0.0' },
  paths: {
    '/v1/node-definitions': {
      get: {
        operationId: 'listNodeDefinitions',
        security: [{ cookieSession: [] }],
        responses: {
          '200': jsonResponse(
            'Available node definitions',
            'NodeDefinitionListResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/integrations': {
      get: {
        operationId: 'listIntegrations',
        security: [{ cookieSession: [] }],
        responses: {
          '200': jsonResponse(
            'Available integrations',
            'IntegrationListResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
    },
  },
  components: authenticatedComponents(openApiSchemas, problemResponses),
});
