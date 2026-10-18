import { projectContractSchema } from '../schema-projection.js';
import {
  jsonResponse,
  jsonRequest,
  uuidPathParameter,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  problemResponse,
  queryParameter,
} from '../primitives.js';
import * as settings from '../../schemas/identity/federation/settings.js';
import * as signIn from '../../schemas/identity/federation/sign-in.js';
import { authorizationStartedSchema } from '../../schemas/identity/federation/authorization.js';
export function federationContractSchemas(target: 'client' | 'openapi') {
  return Object.fromEntries(
    (
      [
        ['FederationSettings', settings.federationSettingsSchema, 'output'],
        [
          'FederationOrganizationCreate',
          settings.federationOrganizationCreateSchema,
          'input',
        ],
        [
          'FederationWorkspaceLink',
          settings.federationWorkspaceLinkSchema,
          'input',
        ],
        [
          'FederationDomainCreate',
          settings.federationDomainCreateSchema,
          'input',
        ],
        [
          'FederationRevisionCommand',
          settings.federationRevisionCommandSchema,
          'input',
        ],
        [
          'FederationEnforcement',
          settings.federationEnforcementSchema,
          'input',
        ],
        ['OidcProviderCreate', settings.oidcProviderCreateSchema, 'input'],
        ['OidcProviderUpdate', settings.oidcProviderUpdateSchema, 'input'],
        ['FederationTestStart', settings.federationTestStartSchema, 'input'],
        ['FederationDiscovery', signIn.federationDiscoverySchema, 'output'],
        ['FederationSignInStart', signIn.federationSignInStartSchema, 'input'],
        ['AuthorizationStarted', authorizationStartedSchema, 'output'],
      ] as const
    ).map(([name, schema, io]) => [
      name,
      projectContractSchema(name, schema, io, target),
    ]),
  );
}
const errors = {
  '400': problemResponse('Invalid request or configuration missing'),
  '401': problemResponse('Session required'),
  '403': problemResponse('Owner authority or CSRF refused'),
  '404': problemResponse('Resource unavailable'),
  '409': problemResponse('Settings changed or command conflict'),
  '429': problemResponse('Rate limited'),
  '500': problemResponse('Unexpected failure'),
  '503': problemResponse('Identity provider unavailable'),
};
function operation(
  operationId: string,
  request?: string,
  path?: 'domainId' | 'providerId',
) {
  return {
    operationId,
    security: [{ cookieSession: [] }],
    parameters: [
      uuidPathParameter('workspaceId'),
      ...(path === undefined ? [] : [uuidPathParameter(path)]),
      ...(request === undefined
        ? []
        : [csrfHeaderParameter(), idempotencyHeaderParameter()]),
    ],
    ...(request === undefined ? {} : { requestBody: jsonRequest(request) }),
    responses: {
      '200': jsonResponse(
        'Safe organization sign-in settings',
        'FederationSettings',
      ),
      ...errors,
    },
  };
}
export const federationContractPaths = {
  '/v1/workspaces/{workspaceId}/sso': {
    get: operation('readFederationSettings'),
  },
  '/v1/workspaces/{workspaceId}/sso/organization': {
    post: operation(
      'createIdentityOrganization',
      'FederationOrganizationCreate',
    ),
  },
  '/v1/workspaces/{workspaceId}/sso/workspaces': {
    post: operation(
      'linkIdentityOrganizationWorkspace',
      'FederationWorkspaceLink',
    ),
  },
  '/v1/workspaces/{workspaceId}/sso/domains': {
    post: operation('createIdentityDomain', 'FederationDomainCreate'),
  },
  '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/verify': {
    post: operation(
      'verifyIdentityDomain',
      'FederationRevisionCommand',
      'domainId',
    ),
  },
  '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/renew': {
    post: operation(
      'renewIdentityDomainChallenge',
      'FederationRevisionCommand',
      'domainId',
    ),
  },
  '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/remove': {
    post: operation(
      'removeIdentityDomain',
      'FederationRevisionCommand',
      'domainId',
    ),
  },
  '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/enforcement': {
    put: operation(
      'configureIdentityDomainEnforcement',
      'FederationEnforcement',
      'domainId',
    ),
  },
  '/v1/workspaces/{workspaceId}/sso/providers': {
    post: operation('createOidcProvider', 'OidcProviderCreate'),
  },
  '/v1/workspaces/{workspaceId}/sso/providers/{providerId}': {
    put: operation('updateOidcProvider', 'OidcProviderUpdate', 'providerId'),
  },
  '/v1/workspaces/{workspaceId}/sso/providers/{providerId}/remove': {
    post: operation(
      'removeOidcProvider',
      'FederationRevisionCommand',
      'providerId',
    ),
  },
  '/v1/auth/federation/discover': {
    get: {
      operationId: 'discoverOrganizationSignIn',
      parameters: [
        queryParameter('domain', settings.federationDomainNameSchema, true),
      ],
      responses: {
        '200': jsonResponse(
          'Enabled providers for the exact verified domain',
          'FederationDiscovery',
        ),
        ...errors,
      },
    },
  },
  '/v1/auth/federation/oidc/start': {
    post: {
      operationId: 'startOrganizationOidcSignIn',
      requestBody: jsonRequest('FederationSignInStart'),
      responses: {
        '200': jsonResponse(
          'Browser-bound authorization URL',
          'AuthorizationStarted',
        ),
        ...errors,
      },
    },
  },
  '/v1/auth/federation/oidc/test': {
    post: {
      operationId: 'startOrganizationOidcTest',
      security: [{ cookieSession: [] }],
      parameters: [csrfHeaderParameter()],
      requestBody: jsonRequest('FederationTestStart'),
      responses: {
        '200': jsonResponse(
          'Owner-bound provider test authorization URL',
          'AuthorizationStarted',
        ),
        ...errors,
      },
    },
  },
  '/v1/auth/federation/oidc/callback': {
    get: {
      operationId: 'finishOrganizationOidcSignIn',
      parameters: [
        {
          name: 'state',
          in: 'query',
          required: true,
          schema: { type: 'string', maxLength: 43 },
        },
        {
          name: 'code',
          in: 'query',
          required: true,
          schema: { type: 'string', maxLength: 4096 },
        },
      ],
      responses: {
        '302': {
          description:
            'Safe same-origin landing after single-use proof consumption',
        },
      },
    },
  },
};
