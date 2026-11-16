import { changePasswordAndRevokeSessions } from '@pertexo/core/identity';
import { requireDoubleSubmitCsrf } from '../better-auth/csrf.js';
import { PASSWORD_LIMITS } from '@pertexo/workflow-model';
import { newPasswordSchema } from './new-password.js';
import {
  prepareReplacement,
  replaceSessionCookie,
} from './successor-session.js';
import {
  APIError,
  createAuthEndpoint,
  sensitiveSessionMiddleware,
} from 'better-auth/api';
import type { Pool } from 'pg';
import { z } from 'zod';

export function createChangePertexoPasswordEndpoint(pool: Pool) {
  return createAuthEndpoint(
    '/account-security/password/change',
    {
      method: 'POST',
      requireHeaders: true,
      use: [sensitiveSessionMiddleware],
      body: z
        .object({
          currentPassword: z
            .string()
            .min(1)
            .max(PASSWORD_LIMITS.maximumCharacters),
          newPassword: newPasswordSchema,
        })
        .strict(),
    },
    async (context) => {
      requireDoubleSubmitCsrf(context.headers);
      const current = context.context.session;
      const replacement = prepareReplacement(context, current.session.id);
      const password = await context.context.password.hash(
        context.body.newPassword,
      );
      const result = await changePasswordAndRevokeSessions(pool, {
        userId: current.user.id,
        currentPassword: context.body.currentPassword,
        replacement,
        newPasswordHash: password,
        verify: (hash, suppliedPassword) =>
          context.context.password.verify({
            hash,
            password: suppliedPassword,
          }),
      });
      if (result === 'inactive') throw new APIError('UNAUTHORIZED');
      if (result === 'invalid')
        throw new APIError('BAD_REQUEST', {
          code: 'INVALID_PASSWORD',
          message: 'The current password is incorrect.',
        });
      await replaceSessionCookie(context, pool, replacement.token);
      return context.json({ changed: true });
    },
  );
}
