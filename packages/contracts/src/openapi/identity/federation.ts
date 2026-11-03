import { federationRoutes } from '../../routes/identity/federation.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { authorizationStartedSchema } from '../../schemas/identity/federation/authorization.js';
import * as settings from '../../schemas/identity/federation/settings.js';
import * as signIn from '../../schemas/identity/federation/sign-in.js';
import {
  csrfHeaderParameter,
  jsonRequest,
  jsonResponse,
  problemResponse,
  queryParameter,
} from '../primitives.js';
import { projectContractSchema } from '../schema-projection.js';
export function federationContractSchemas() {
  return {
    ...routeSchemas(Object.values(federationRoutes)),
    ...Object.fromEntries(
      (
        [
          ['FederationTestStart', settings.federationTestStartSchema, 'input'],
          ['FederationDiscovery', signIn.federationDiscoverySchema, 'output'],
          [
            'FederationSignInStart',
            signIn.federationSignInStartSchema,
            'input',
          ],
          ['AuthorizationStarted', authorizationStartedSchema, 'output'],
        ] as const
      ).map(([name, schema, io]) => [
        name,
        projectContractSchema(name, schema, io),
      ]),
    ),
  };
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

export const federationContractPaths = {
  ...routePaths(Object.values(federationRoutes)),

  '/v1/auth/federation/discover': {
    get: {
      operationId: 'discoverOrganizationSignIn',
      parameters: [
        queryParameter('domain', settings.federationDomainNameSchema, {
          required: true,
        }),
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
  '/v1/auth/federation/saml/start': {
    post: {
      operationId: 'startOrganizationSamlSignIn',
      requestBody: jsonRequest('FederationSignInStart'),
      responses: {
        '200': jsonResponse(
          'Browser-bound Redirect URL',
          'AuthorizationStarted',
        ),
        ...errors,
      },
    },
  },
  '/v1/auth/federation/saml/test': {
    post: {
      operationId: 'startOrganizationSamlTest',
      security: [{ cookieSession: [] }],
      parameters: [csrfHeaderParameter()],
      requestBody: jsonRequest('FederationTestStart'),
      responses: {
        '200': jsonResponse(
          'Owner-bound provider test Redirect URL',
          'AuthorizationStarted',
        ),
        ...errors,
      },
    },
  },
  '/v1/auth/federation/saml/callback': {
    post: {
      operationId: 'finishOrganizationSamlSignIn',
      requestBody: {
        required: true,
        content: {
          'application/x-www-form-urlencoded': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['SAMLResponse', 'RelayState'],
              properties: {
                SAMLResponse: {
                  type: 'string',
                  maxLength: settings.SAML_LIMITS.encodedCharacters,
                },
                RelayState: { type: 'string', maxLength: 43 },
              },
            },
          },
        },
      },
      responses: {
        '302': {
          description:
            'Safe same-origin landing after signed, browser-bound, single-use proof verification',
        },
      },
    },
  },
};
