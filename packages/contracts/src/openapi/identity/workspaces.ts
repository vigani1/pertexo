import {
  directoryContractSchemas,
  directoryContractPaths,
} from './directory.js';
import {
  federationContractSchemas,
  federationContractPaths,
} from './federation.js';
import {
  governanceContractSchemas,
  governanceContractPaths,
} from './governance.js';
import { dataTableRoutes } from '../../routes/identity/data-tables.js';
import { variableRoutes } from '../../routes/identity/variables.js';
import { workspaceRoutes } from '../../routes/identity/workspaces.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import {
  apiTokenContractPaths,
  apiTokenContractSchemas,
} from './api-tokens.js';
import { apiProblemSchema } from '../../errors/api-problem.js';
import {
  authenticationContractPaths,
  authenticationContractSchemas,
} from './authentication.js';
import {
  authenticatedComponents,
  jsonSchema,
  problemResponse,
} from '../primitives.js';
import {
  workspaceInvitationContractPaths,
  workspaceInvitationContractSchemas,
} from './invitations.js';
import {
  userProfileResponseSchema,
  userProfileUpdateRequestSchema,
  userProfileUpdateResponseSchema,
} from '../../schemas/identity/workspaces.js';

const schemas = Object.freeze({
  ...apiTokenContractSchemas,
  ...routeSchemas(Object.values(variableRoutes)),
  ...routeSchemas(Object.values(workspaceRoutes)),
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  UserProfileResponse: jsonSchema(userProfileResponseSchema, 'output'),
  UserProfileUpdateRequest: jsonSchema(userProfileUpdateRequestSchema, 'input'),
  UserProfileUpdateResponse: jsonSchema(
    userProfileUpdateResponseSchema,
    'output',
  ),
  ...workspaceInvitationContractSchemas,
  ...authenticationContractSchemas,
});

const openApiSchemas = {
  ...schemas,
  ...routeSchemas(Object.values(dataTableRoutes)),
  ...governanceContractSchemas(),
  ...federationContractSchemas(),
  ...directoryContractSchemas(),
};

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  ServiceUnavailable: problemResponse('Upstream service unavailable'),
  RateLimited: problemResponse('Rate limited'),
  Unexpected: problemResponse('Unexpected server error'),
});

export const identityWorkspaceOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Pertexo Identity and Workspace API',
    version: '1.0.0',
  },
  paths: {
    ...apiTokenContractPaths,
    ...routePaths(Object.values(variableRoutes)),
    ...routePaths(Object.values(dataTableRoutes)),
    ...governanceContractPaths,
    ...authenticationContractPaths,
    ...federationContractPaths,
    ...directoryContractPaths,
    ...routePaths(Object.values(workspaceRoutes)),
    ...workspaceInvitationContractPaths,
  },
  components: {
    ...authenticatedComponents(openApiSchemas, problemResponses, {
      automation: true,
    }),
    securitySchemes: {
      ...authenticatedComponents(openApiSchemas, problemResponses, {
        automation: true,
      }).securitySchemes,
      invitationBinding: {
        type: 'apiKey',
        in: 'cookie',
        name: 'pertexo_invitation_intent',
      },
    },
  },
});
