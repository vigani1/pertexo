import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  responseReference,
} from '../primitives.js';
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
  authenticationProviderSchema,
} from '../../schemas/identity/authentication.js';
import {
  socialSignInStartSchema,
  socialSignInStartedSchema,
} from '../../schemas/identity/federation.js';

/**
 * Sign-in, browser-session and account-security operations of the
 * identity-workspace contract. Problem responses resolve against the
 * document that composes this fragment.
 */
export const authenticationContractSchemas = Object.freeze({
  SocialSignInStart: jsonSchema(socialSignInStartSchema, 'input'),
  SocialSignInStarted: jsonSchema(socialSignInStartedSchema, 'output'),
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
});

export const authenticationContractPaths = Object.freeze({
  '/v1/auth/sign-in/social': {
    post: {
      operationId: 'startSocialSignIn',
      requestBody: jsonRequest('SocialSignInStart'),
      responses: {
        '200': jsonResponse(
          'Browser-bound provider authorization URL',
          'SocialSignInStarted',
        ),
        '400': responseReference('BadRequest'),
        '403': responseReference('Forbidden'),
        '404': responseReference('NotFound'),
        '429': responseReference('RateLimited'),
        '503': problemResponse('Authentication temporarily unavailable'),
      },
    },
  },
  '/v1/auth/federation/social/callback/{provider}': {
    get: {
      operationId: 'finishSocialSignIn',
      parameters: [
        {
          name: 'provider',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            enum: authenticationProviderSchema.options,
          },
        },
      ],
      responses: {
        '302': {
          description:
            'Signed session delivered, or safe sign-in failure; no credential in the body.',
        },
        '404': responseReference('NotFound'),
        '429': responseReference('RateLimited'),
      },
    },
  },
  '/v1/auth/federation/social/callback/apple': {
    post: {
      operationId: 'landAppleSignInForm',
      description:
        'Bounded URL-encoded form landing; redirects to the GET callback, which verifies the single-use browser-bound identity proof. Front-channel ID tokens and profile data are ignored.',
      requestBody: {
        required: true,
        content: {
          'application/x-www-form-urlencoded': {
            schema: {
              type: 'object',
              properties: {
                state: { type: 'string', maxLength: 43 },
                code: { type: 'string', maxLength: 4096 },
              },
            },
          },
        },
      },
      responses: {
        '303': {
          description: 'Same-origin GET callback; no identity change yet.',
        },
        '400': responseReference('BadRequest'),
        '413': problemResponse('Provider form exceeds 32 KiB'),
        '429': responseReference('RateLimited'),
      },
    },
  },
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
    patch: {
      operationId: 'updateCurrentUserProfile',
      security: [{ cookieSession: [] }],
      parameters: [csrfHeaderParameter(), idempotencyHeaderParameter()],
      requestBody: jsonRequest('UserProfileUpdateRequest'),
      responses: {
        '200': jsonResponse(
          'Current user display-name change receipt',
          'UserProfileUpdateResponse',
        ),
        '400': responseReference('BadRequest'),
        '401': responseReference('Unauthenticated'),
        '403': responseReference('Forbidden'),
        '409': responseReference('Conflict'),
        '412': problemResponse('Profile revision changed'),
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
