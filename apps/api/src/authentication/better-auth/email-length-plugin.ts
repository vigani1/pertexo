import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { EMAIL_ADDRESS_LIMITS } from '@pertexo/workflow-model';

/** The Better Auth routes that take an address, and the field each sends it in. */
const EMAIL_FIELD_BY_PATH: Readonly<Record<string, string>> = Object.freeze({
  '/sign-up/email': 'email',
  '/change-email': 'newEmail',
});

/**
 * Refuses a newly entered address longer than RFC 5321 allows before Better
 * Auth reads it: sign-up and an email change. Sign-in, SSO, SCIM and password
 * reset identify existing accounts and take the wider stored bound.
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
              value.length > EMAIL_ADDRESS_LIMITS.newAddressCharacters
            )
              // The browser words the refusal from the code.
              throw new APIError('BAD_REQUEST', { code: 'INVALID_EMAIL' });
            return Promise.resolve();
          }),
        },
      ],
    },
  };
}
