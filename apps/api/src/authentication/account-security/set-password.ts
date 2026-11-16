import { setupPasswordAndRevokeSessions } from '@pertexo/core/identity';
import { requireDoubleSubmitCsrf } from '../better-auth/csrf.js';
import { newPasswordSchema } from './new-password.js';
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

export function createSetPertexoPasswordEndpoint(pool: Pool) {
  return createAuthEndpoint(
    '/account-security/password/setup',
    {
      method: 'POST',
      requireHeaders: true,
      use: [freshSessionMiddleware],
      body: z.object({ newPassword: newPasswordSchema }).strict(),
    },
    async (context) => {
      requireDoubleSubmitCsrf(context.headers);
      const current = context.context.session;
      const replacement = prepareReplacement(context, current.session.id);
      const password = await context.context.password.hash(
        context.body.newPassword,
      );
      const result = await setupPasswordAndRevokeSessions(pool, {
        userId: current.user.id,
        passwordHash: password,
        replacement,
      });
      if (result === 'inactive') throw new APIError('UNAUTHORIZED');
      if (result === 'unverified')
        throw new APIError('FORBIDDEN', {
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message: 'Verify your email before adding a password.',
        });
      if (result === 'limit')
        throw new APIError('BAD_REQUEST', {
          code: 'AUTHENTICATION_METHOD_LIMIT',
          message: 'Remove an unused sign-in method before adding another.',
        });
      if (result === 'already')
        throw new APIError('CONFLICT', {
          code: 'PASSWORD_ALREADY_CONFIGURED',
          message: 'A password is already configured.',
        });
      await replaceSessionCookie(context, pool, replacement.token);
      return context.json({ configured: true });
    },
  );
}
