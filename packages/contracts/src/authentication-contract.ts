import {
  csrfHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  queryParameter,
  responseReference,
} from './openapi-primitives.js';
import {
  accountSecurityLinkStartRequestSchema,
  accountSecurityLinkStartResponseSchema,
  accountSecurityMethodUnlinkRequestSchema,
  accountSecurityMethodUnlinkResponseSchema,
  accountSecurityPasswordChangeRequestSchema,
  accountSecurityPasswordChangeResponseSchema,
  accountSecurityPasswordSetupRequestSchema,
  accountSecurityPasswordSetupResponseSchema,
  accountSecurityResponseSchema,
  accountSecurityRevokeOthersResponseSchema,
  accountSecuritySessionRevokeRequestSchema,
  accountSecuritySessionRevokeResponseSchema,
  accountSecuritySessionsResponseSchema,
  authenticationCapabilitiesResponseSchema,
  legacyMethodMigrationStartRequestSchema,
  legacyMethodMigrationStartResponseSchema,
  oidcAuthorizationCodeSchema,
  oidcStateSchema,
} from './http/authentication.js';

/**
 * Sign-in, browser-session and account-security operations of the
 * identity-workspace contract. Problem responses resolve against the
 * document that composes this fragment.
 */
export const authenticationContractSchemas = Object.freeze({
  AuthenticationCapabilitiesResponse: jsonSchema(
    authenticationCapabilitiesResponseSchema,
    'output',
  ),
  AccountSecuritySessionsResponse: jsonSchema(
    accountSecuritySessionsResponseSchema,
    'output',
  ),
  AccountSecuritySessionRevokeRequest: jsonSchema(
    accountSecuritySessionRevokeRequestSchema,
    'input',
  ),
  AccountSecuritySessionRevokeResponse: jsonSchema(
    accountSecuritySessionRevokeResponseSchema,
    'output',
  ),
  AccountSecurityRevokeOthersResponse: jsonSchema(
    accountSecurityRevokeOthersResponseSchema,
    'output',
  ),
  AccountSecurityResponse: jsonSchema(accountSecurityResponseSchema, 'output'),
  AccountSecurityPasswordChangeRequest: jsonSchema(
    accountSecurityPasswordChangeRequestSchema,
    'input',
  ),
  AccountSecurityPasswordChangeResponse: jsonSchema(
    accountSecurityPasswordChangeResponseSchema,
    'output',
  ),
  AccountSecurityPasswordSetupRequest: jsonSchema(
    accountSecurityPasswordSetupRequestSchema,
    'input',
  ),
  AccountSecurityPasswordSetupResponse: jsonSchema(
    accountSecurityPasswordSetupResponseSchema,
    'output',
  ),
  AccountSecurityMethodUnlinkRequest: jsonSchema(
    accountSecurityMethodUnlinkRequestSchema,
    'input',
  ),
  AccountSecurityMethodUnlinkResponse: jsonSchema(
    accountSecurityMethodUnlinkResponseSchema,
    'output',
  ),
  AccountSecurityLinkStartRequest: jsonSchema(
    accountSecurityLinkStartRequestSchema,
    'input',
  ),
  AccountSecurityLinkStartResponse: jsonSchema(
    accountSecurityLinkStartResponseSchema,
    'output',
  ),
  LegacyMethodMigrationStartRequest: jsonSchema(
    legacyMethodMigrationStartRequestSchema,
    'input',
  ),
  LegacyMethodMigrationStartResponse: jsonSchema(
    legacyMethodMigrationStartResponseSchema,
    'output',
  ),
});

export const authenticationContractPaths = Object.freeze({
  '/v1/auth/capabilities': {
    get: {
      operationId: 'getAuthenticationCapabilities',
      responses: {
        '200': jsonResponse(
          'Configured public authentication methods',
          'AuthenticationCapabilitiesResponse',
        ),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/users/me': {
    get: {
      operationId: 'getCurrentUserProfile',
      security: [{ cookieSession: [] }],
      responses: {
        '200': jsonResponse('Current user profile', 'UserProfileResponse'),
        '401': responseReference('Unauthenticated'),
        '429': responseReference('RateLimited'),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/auth/account-security/sessions': {
    get: {
      operationId: 'listAccountSecuritySessions',
      security: [{ cookieSession: [] }],
      responses: {
        '200': jsonResponse(
          'Current user session summaries',
          'AccountSecuritySessionsResponse',
        ),
        '401': responseReference('Unauthenticated'),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/auth/account-security': {
    get: {
      operationId: 'getAccountSecurity',
      security: [{ cookieSession: [] }],
      responses: {
        '200': jsonResponse(
          'Current authentication methods',
          'AccountSecurityResponse',
        ),
        '401': responseReference('Unauthenticated'),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/auth/account-security/password/change': {
    post: {
      operationId: 'changeAccountPassword',
      security: [{ cookieSession: [] }],
      parameters: [csrfHeaderParameter()],
      requestBody: jsonRequest('AccountSecurityPasswordChangeRequest'),
      responses: {
        '200': jsonResponse(
          'Password changed',
          'AccountSecurityPasswordChangeResponse',
        ),
        '400': responseReference('BadRequest'),
        '401': responseReference('Unauthenticated'),
        '403': responseReference('Forbidden'),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/auth/account-security/password/setup': {
    post: {
      operationId: 'setAccountPassword',
      security: [{ cookieSession: [] }],
      parameters: [csrfHeaderParameter()],
      requestBody: jsonRequest('AccountSecurityPasswordSetupRequest'),
      responses: {
        '200': jsonResponse(
          'Password configured',
          'AccountSecurityPasswordSetupResponse',
        ),
        '400': responseReference('BadRequest'),
        '401': responseReference('Unauthenticated'),
        '403': responseReference('Forbidden'),
        '409': responseReference('Conflict'),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/auth/account-security/methods/unlink': {
    post: {
      operationId: 'unlinkAccountSecurityMethod',
      security: [{ cookieSession: [] }],
      parameters: [csrfHeaderParameter()],
      requestBody: jsonRequest('AccountSecurityMethodUnlinkRequest'),
      responses: {
        '200': jsonResponse(
          'Authentication method unlinked',
          'AccountSecurityMethodUnlinkResponse',
        ),
        '400': responseReference('BadRequest'),
        '401': responseReference('Unauthenticated'),
        '403': responseReference('Forbidden'),
        '404': responseReference('Forbidden'),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/auth/account-security/methods/link/start': {
    post: {
      operationId: 'startAccountMethodLink',
      security: [{ cookieSession: [] }],
      parameters: [csrfHeaderParameter()],
      requestBody: jsonRequest('AccountSecurityLinkStartRequest'),
      responses: {
        '200': jsonResponse(
          'Provider authorization started',
          'AccountSecurityLinkStartResponse',
        ),
        '400': responseReference('BadRequest'),
        '401': responseReference('Unauthenticated'),
        '403': responseReference('Forbidden'),
        '404': responseReference('Forbidden'),
        '409': responseReference('Conflict'),
        '503': responseReference('ServiceUnavailable'),
      },
    },
  },
  '/v1/auth/legacy-migration/start': {
    post: {
      operationId: 'startLegacyMethodMigration',
      requestBody: jsonRequest('LegacyMethodMigrationStartRequest'),
      responses: {
        '200': jsonResponse(
          'Legacy method proof started',
          'LegacyMethodMigrationStartResponse',
        ),
        '400': responseReference('BadRequest'),
        '404': responseReference('Forbidden'),
        '503': responseReference('ServiceUnavailable'),
      },
    },
  },
  '/v1/auth/account-security/sessions/revoke': {
    post: {
      operationId: 'revokeAccountSecuritySession',
      security: [{ cookieSession: [] }],
      parameters: [csrfHeaderParameter()],
      requestBody: jsonRequest('AccountSecuritySessionRevokeRequest'),
      responses: {
        '200': jsonResponse(
          'Session revocation result',
          'AccountSecuritySessionRevokeResponse',
        ),
        '400': responseReference('BadRequest'),
        '401': responseReference('Unauthenticated'),
        '403': responseReference('Forbidden'),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/auth/account-security/sessions/revoke-others': {
    post: {
      operationId: 'revokeOtherAccountSecuritySessions',
      security: [{ cookieSession: [] }],
      parameters: [csrfHeaderParameter()],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', additionalProperties: false },
          },
        },
      },
      responses: {
        '200': jsonResponse(
          'Other-session revocation result',
          'AccountSecurityRevokeOthersResponse',
        ),
        '401': responseReference('Unauthenticated'),
        '403': responseReference('Forbidden'),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/auth/oidc/start': {
    get: {
      operationId: 'startOidcLogin',
      responses: {
        '200': jsonResponse(
          'OIDC authorization transaction',
          'OidcStartResponse',
        ),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/auth/oidc/callback': {
    get: {
      operationId: 'completeOidcLogin',
      parameters: [
        queryParameter('code', oidcAuthorizationCodeSchema, true),
        queryParameter('state', oidcStateSchema, true),
      ],
      responses: {
        '303': {
          description: 'Browser session established; return to the web app',
          headers: {
            Location: {
              description: 'Configured same-origin application landing path',
              schema: { type: 'string', pattern: '^/(?!/)' },
            },
          },
        },
        '400': responseReference('BadRequest'),
        '503': responseReference('ServiceUnavailable'),
        '500': responseReference('Unexpected'),
      },
    },
  },
  '/v1/auth/logout': {
    post: {
      operationId: 'logoutSession',
      security: [{ cookieSession: [] }],
      parameters: [csrfHeaderParameter()],
      responses: {
        '204': { description: 'Browser session revoked' },
        '401': responseReference('Unauthenticated'),
        '403': responseReference('Forbidden'),
        '500': responseReference('Unexpected'),
      },
    },
  },
});
