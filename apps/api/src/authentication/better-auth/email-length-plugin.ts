import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { EMAIL_ADDRESS_LIMITS } from '@pertexo/workflow-model';

/** The Better Auth routes that take an address, and the field each sends it in. */
const EMAIL_FIELD_BY_PATH: Readonly<Record<string, string>> = Object.freeze({
  '/sign-up/email': 'email',
  '/change-email': 'newEmail',
});

/**
 * Refuses an address longer than RFC 5321 allows before Better Auth reads
 * it, so sign-up and an email change share the bound every other boundary
 * uses. Stored rows may be wider; this bounds only what arrives.
 */
export function createEmailLengthPlugin(): BetterAuthPlugin {
  return {
    id: 'pertexo-email-length',
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path !== undefined && context.path in EMAIL_FIELD_BY_PATH,
          handler: createAuthMiddleware((context) => {
            const field = EMAIL_FIELD_BY_PATH[context.path];
            const value: unknown =
              field !== undefined &&
              typeof context.body === 'object' &&
              context.body !== null
                ? Reflect.get(context.body, field)
                : undefined;
            if (
              typeof value === 'string' &&
              value.length > EMAIL_ADDRESS_LIMITS.characters
            )
              throw new APIError('BAD_REQUEST', {
                code: 'INVALID_EMAIL',
                message: `Use an email address of at most ${String(EMAIL_ADDRESS_LIMITS.characters)} characters.`,
              });
            return Promise.resolve();
          }),
        },
      ],
    },
  };
}
