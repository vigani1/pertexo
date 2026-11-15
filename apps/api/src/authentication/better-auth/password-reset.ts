import type { AuthenticationDiagnostics } from './diagnostics.js';
import { randomBytes } from 'node:crypto';
import { issuePasswordResetProof } from '@pertexo/core/identity';
import { createAuthEndpoint, originCheck } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AuthenticationMail } from '../mail/authentication-mail.js';
import { randomSecretToken } from '../../identity/secret-token.js';
import { EMAIL_ADDRESS_LIMITS } from '@pertexo/workflow-model';

/** A reset link's token: 192 random bits, short enough for a mailed URL. */
const RESET_TOKEN_BYTES = 24;

/** Replace native issuance so lookup, proof and mail share the user lock. */
export function createPasswordResetPlugin(
  pool: Pool,
  mail: AuthenticationMail,
  diagnostics: AuthenticationDiagnostics,
) {
  return {
    id: 'pertexo-password-reset',
    endpoints: {
      requestPasswordReset: createAuthEndpoint(
        '/request-password-reset',
        {
          method: 'POST',
          body: z.object({
            email: z.email().max(EMAIL_ADDRESS_LIMITS.characters),
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
          // Comparable bounded work for all addresses, including absent credentials.
          await context.context.password.hash(randomSecretToken());
          try {
            const token = randomBytes(RESET_TOKEN_BYTES).toString('base64url');
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
          } catch {
            diagnostics.passwordResetFailure();
          }
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
