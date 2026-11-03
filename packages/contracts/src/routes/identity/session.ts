import * as schemas from '../../schemas/identity/workspaces.js';
import { named as projected, named } from '../define.js';
import { defineRoute } from '../define.js';
import { responseReference } from '../../openapi/primitives.js';
export const sessionRoutes = {
  me: defineRoute({
    operationId: 'getCurrentUserProfile',
    method: 'get',
    path: '/v1/users/me',
    access: { auth: 'session' },
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    success: {
      status: 200,
      description: 'Current user profile',
      body: projected('UserProfileResponse', schemas.userProfileResponseSchema),
    },
    problems: {
      '401': responseReference('Unauthenticated'),
      '429': responseReference('RateLimited'),
      '500': responseReference('Unexpected'),
    },
  }),
  updateMe: defineRoute({
    operationId: 'updateCurrentUserProfile',
    method: 'patch',
    path: '/v1/users/me',
    access: { auth: 'session' },
    rateLimit: 'actor_mutation',
    cacheControl: 'private, no-store',
    body: named(
      'UserProfileUpdateRequest',
      schemas.userProfileUpdateRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description: 'Current user display-name change receipt',
      body: projected(
        'UserProfileUpdateResponse',
        schemas.userProfileUpdateResponseSchema,
      ),
    },
    problems: {
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '409': responseReference('Conflict'),
      '412': {
        description: 'Profile revision changed',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/ApiProblem' },
          },
        },
      },
      '429': responseReference('RateLimited'),
      '500': responseReference('Unexpected'),
    },
  }),
  logout: defineRoute({
    operationId: 'logoutSession',
    method: 'post',
    path: '/v1/auth/logout',
    access: { auth: 'session' },
    rateLimit: 'actor_mutation',
    success: {
      status: 204,
      response: { description: 'Browser session revoked' },
    },
    problems: {
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '500': responseReference('Unexpected'),
    },
  }),
};
