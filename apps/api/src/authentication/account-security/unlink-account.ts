import { unlinkMethodAndRevokeSessions } from '@pertexo/core/identity';
import type { SocialProviderGateway } from '../social-provider.types.js';
import { requireDoubleSubmitCsrf } from '../better-auth/csrf.js';
import {
  prepareReplacement,
  replaceSessionCookie,
} from './successor-session.js';
import {
  APIError,
  createAuthEndpoint,
  freshSessionMiddleware,
} from 'better-auth/api';
import type { Pool } from 'pg';
import { z } from 'zod';

export function createUnlinkPertexoAccountEndpoint(
  pool: Pool,
  socialProviders: SocialProviderGateway['available'],
  organizationProtocols: readonly ('oidc' | 'saml')[],
) {
  return createAuthEndpoint(
    '/account-security/methods/unlink',
    {
      method: 'POST',
      requireHeaders: true,
      use: [freshSessionMiddleware],
      body: z.object({ methodId: z.uuid() }).strict(),
    },
    async (context) => {
      requireDoubleSubmitCsrf(context.headers);
      const current = context.context.session;
      const replacement = prepareReplacement(context, current.session.id);
      const result = await unlinkMethodAndRevokeSessions(pool, {
        userId: current.user.id,
        methodId: context.body.methodId,
        socialProviders,
        organizationProtocols,
        replacement,
      });
      if (result === 'inactive') throw new APIError('UNAUTHORIZED');
      if (result === 'protected_recovery')
        throw new APIError('FORBIDDEN', {
          code: 'RECOVERY_PASSWORD_REQUIRED',
          message:
            'Keep the recovery owner password while organization SSO is required.',
        });
      if (result === 'last_method')
        throw new APIError('BAD_REQUEST', {
          code: 'LAST_AUTHENTICATION_METHOD',
          message:
            'Add another working sign-in method allowed by your organization before removing this one.',
        });
      if (result === 'not_found')
        throw new APIError('NOT_FOUND', {
          code: 'AUTHENTICATION_METHOD_NOT_FOUND',
          message: 'The authentication method is not available.',
        });
      await replaceSessionCookie(context, pool, replacement.token);
      return context.json({ unlinked: true });
    },
  );
}
