import { resetPasswordAndRevokeSessions } from '@pertexo/core/identity';
import { newPasswordSchema } from './new-password.js';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import type { Pool } from 'pg';
import { z } from 'zod';

/** The longest password-reset token a request may carry. */
const RESET_TOKEN_MAX_CHARACTERS = 512;

export function createResetPertexoPasswordEndpoint(pool: Pool) {
  return createAuthEndpoint(
    '/account-security/password/reset',
    {
      method: 'POST',
      body: z
        .object({
          token: z.string().min(1).max(RESET_TOKEN_MAX_CHARACTERS),
          newPassword: newPasswordSchema,
        })
        .strict(),
    },
    async (context) => {
      const passwordHash = await context.context.password.hash(
        context.body.newPassword,
      );
      const result = await resetPasswordAndRevokeSessions(pool, {
        token: context.body.token,
        passwordHash,
      });
      if (result === 'invalid')
        throw new APIError('BAD_REQUEST', {
          code: 'INVALID_TOKEN',
          message: 'The reset link is invalid or expired.',
        });
      return context.json({ status: true });
    },
  );
}
