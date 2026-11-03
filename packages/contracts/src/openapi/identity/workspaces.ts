import { apiProblemSchema } from '../../errors/api-problem.js';
import { dataTableRoutes } from '../../routes/identity/data-tables.js';
import { sessionRoutes } from '../../routes/identity/session.js';
import { variableRoutes } from '../../routes/identity/variables.js';
import { workspaceRoutes } from '../../routes/identity/workspaces.js';
import type { RoutePaths } from '../../routes/openapi.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import {
  authenticatedComponents,
  jsonSchema,
  problemResponse,
} from '../primitives.js';
import {
  apiTokenContractPaths,
  apiTokenContractSchemas,
} from './api-tokens.js';
import {
  authenticationContractPaths,
  authenticationContractSchemas,
} from './authentication.js';
import {
  directoryContractPaths,
  directoryContractSchemas,
} from './directory.js';
import {
  federationContractPaths,
  federationContractSchemas,
} from './federation.js';
import {
  governanceContractPaths,
  governanceContractSchemas,
} from './governance.js';
import {
  workspaceInvitationContractPaths,
  workspaceInvitationContractSchemas,
} from './invitations.js';

const schemas = Object.freeze({
  ...routeSchemas(Object.values(sessionRoutes)),
  ...apiTokenContractSchemas,
  ...routeSchemas(Object.values(variableRoutes)),
  ...routeSchemas(Object.values(workspaceRoutes)),
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),

  ...workspaceInvitationContractSchemas,
  ...authenticationContractSchemas,
});

const openApiSchemas = {
  ...schemas,
  ...routeSchemas(Object.values(dataTableRoutes)),
  ...governanceContractSchemas(),
  ...federationContractSchemas(),
  ...directoryContractSchemas,
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

type DeclaredIdentityRoute =
  | (typeof variableRoutes)[keyof typeof variableRoutes]
  | (typeof dataTableRoutes)[keyof typeof dataTableRoutes]
  | (typeof workspaceRoutes)[keyof typeof workspaceRoutes];
type IdentityPaths = RoutePaths<readonly DeclaredIdentityRoute[]> &
  typeof apiTokenContractPaths &
  typeof governanceContractPaths &
  typeof authenticationContractPaths &
  typeof federationContractPaths &
  typeof directoryContractPaths &
  typeof workspaceInvitationContractPaths;
const paths: IdentityPaths = {
  ...apiTokenContractPaths,
  ...routePaths(Object.values(variableRoutes)),
  ...routePaths(Object.values(dataTableRoutes)),
  ...governanceContractPaths,
  ...authenticationContractPaths,
  ...federationContractPaths,
  ...directoryContractPaths,
  ...routePaths(Object.values(workspaceRoutes)),
  ...workspaceInvitationContractPaths,
};

export const identityWorkspaceOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Pertexo Identity and Workspace API',
    version: '1.0.0',
  },
  paths,
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
