import { randomBytes } from 'node:crypto';
import { issuePasswordResetProof } from '@pertexo/core/identity';
import { createAuthEndpoint, originCheck } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AuthenticationMail } from '../mail/delivery.js';

/** Replace native issuance so lookup, proof and mail share the user lock. */
export function createPasswordResetPlugin(
  pool: Pool,
  mail: AuthenticationMail,
) {
  return {
    id: 'pertexo-password-reset',
    endpoints: {
      requestPasswordReset: createAuthEndpoint(
        '/request-password-reset',
        {
          method: 'POST',
          body: z.object({
            email: z.email(),
            redirectTo: z.string().optional(),
          }),
          use: [
            originCheck(
              (context: { body?: { redirectTo?: string } }) =>
                context.body?.redirectTo ?? [],
            ),
          ],
        },
        async (context) => {
          const token = randomBytes(24).toString('base64url');
          const callback = encodeURIComponent(context.body.redirectTo ?? '');
          const url = `${context.context.baseURL}/reset-password/${token}?callbackURL=${callback}`;
          const issued = await issuePasswordResetProof(pool, {
            email: context.body.email,
            token,
            prepareMail: (recipient, expiresAt) =>
              mail.preparePasswordReset?.({
                recipient: recipient.email,
                displayName: recipient.displayName,
                url,
                expiresAt,
              }),
          });
          if (issued !== undefined && !issued.queued)
            await mail.sendPasswordReset({
              recipient: issued.recipient.email,
              displayName: issued.recipient.displayName,
              url,
            });
          return context.json({
            status: true,
            message:
              'If this email exists in our system, check your email for the reset link',
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
