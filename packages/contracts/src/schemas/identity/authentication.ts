import { responseSchema } from '../shared/response-schema.js';
import {
  AUTHENTICATION_PROVIDERS,
  PASSWORD_LIMITS,
  EMAIL_ADDRESS_LIMITS,
} from '@pertexo/workflow-model';
import { ACCOUNT_SIGN_IN_METHOD_LIMIT } from '@pertexo/workflow-model';
export { ACCOUNT_SIGN_IN_METHOD_LIMIT };
import { authorizationStartedSchema } from './federation/authorization.js';
import { z } from 'zod';

const AUTHENTICATION_BOUNDS = Object.freeze({
  authenticationReturnPathCharacters: 128,
  minimumLengthMinimum: 8,
  minimumLengthMaximum: PASSWORD_LIMITS.maximumCharacters,
  socialProvidersItems: AUTHENTICATION_PROVIDERS.length,
  accountSecuritySessionsPageItems: 100,
  labelCharacters: 128,
  providerCharacters: 64,
  emailCharacters: EMAIL_ADDRESS_LIMITS.storedAddressCharacters,
  availableProvidersItems: AUTHENTICATION_PROVIDERS.length,
  recoveryCodesRemainingMaximum: 10,
  passwordCharacters: PASSWORD_LIMITS.maximumCharacters,
  currentPasswordCharacters: PASSWORD_LIMITS.maximumCharacters,
  newPasswordMinimumCharacters: PASSWORD_LIMITS.minimumCharacters,
  newPasswordCharacters: PASSWORD_LIMITS.maximumCharacters,
});

/**
 * Where a sign-in may return. Only same-origin app paths matching these
 * known routes are accepted: no scheme, host, `//`, query or fragment.
 */
const AUTHENTICATION_RETURN_PATHS = Object.freeze([
  /^\/invitations\/accept$/u,
  /^\/account\/security$/u,
  // Any page inside a workspace, so a sign-in after the session ended
  // returns there. Plain segments only: no query, fragment or `//`.
  /^\/w\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[A-Za-z0-9_-]+){0,6}$/u,
]);
export const authenticationReturnPathSchema = z
  .string()
  .max(AUTHENTICATION_BOUNDS.authenticationReturnPathCharacters)
  .refine((path) =>
    AUTHENTICATION_RETURN_PATHS.some((pattern) => pattern.test(path)),
  );
export const authenticationProviderSchema = z.enum(AUTHENTICATION_PROVIDERS);
export const authenticationCapabilitiesResponseSchema = responseSchema(
  z
    .object({
      password: z
        .object({
          enabled: z.boolean(),
          minimumLength: z
            .number()
            .int()
            .min(AUTHENTICATION_BOUNDS.minimumLengthMinimum)
            .max(AUTHENTICATION_BOUNDS.minimumLengthMaximum),
          verificationRequired: z.boolean(),
        })
        .strict(),
      socialProviders: z
        .array(authenticationProviderSchema)
        .max(AUTHENTICATION_BOUNDS.socialProvidersItems),
      /** `invitation`: only an invited address can make an account here now. */
      signUp: z.enum(['open', 'invitation']),
    })
    .strict(),
);
const accountSecuritySessionSchema = z
  .object({
    id: z.uuid(),
    current: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .strict();
export const accountSecuritySessionsResponseSchema = responseSchema(
  z
    .object({
      items: z
        .array(accountSecuritySessionSchema)
        .max(AUTHENTICATION_BOUNDS.accountSecuritySessionsPageItems),
    })
    .strict(),
);
export const accountSecuritySessionRevokeRequestSchema = z
  .object({ sessionId: z.uuid() })
  .strict();
export const accountSecuritySessionRevokeResponseSchema = responseSchema(
  z.object({ revoked: z.boolean() }).strict(),
);
export const accountSecurityRevokeOthersResponseSchema = responseSchema(
  z.object({ revokedCount: z.number().int().nonnegative() }).strict(),
);

const accountSecurityMethodSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['password', 'social', 'organization']),
    label: z
      .string()
      .min(1)
      .max(AUTHENTICATION_BOUNDS.labelCharacters)
      .optional(),
    provider: z
      .string()
      .min(1)
      .max(AUTHENTICATION_BOUNDS.providerCharacters)
      .nullable(),
  })
  .strict();
export const accountSecurityResponseSchema = responseSchema(
  z
    .object({
      email: z.email().max(AUTHENTICATION_BOUNDS.emailCharacters),
      emailVerified: z.boolean(),
      availableProviders: z
        .array(authenticationProviderSchema)
        .max(AUTHENTICATION_BOUNDS.availableProvidersItems),
      twoFactor: z
        .object({
          enabled: z.boolean(),
          recoveryCodesRemaining: z
            .number()
            .int()
            .min(0)
            .max(AUTHENTICATION_BOUNDS.recoveryCodesRemainingMaximum)
            .nullable(),
        })
        .strict(),
      methods: z
        .array(accountSecurityMethodSchema)
        .max(ACCOUNT_SIGN_IN_METHOD_LIMIT),
    })
    .strict(),
);
export const accountSecurityMethodUnlinkRequestSchema = z
  .object({ methodId: z.uuid() })
  .strict();
export const accountSecurityMethodUnlinkResponseSchema = responseSchema(
  z.object({ unlinked: z.literal(true) }).strict(),
);
export const accountSecurityLinkStartRequestSchema = z
  .object({
    provider: authenticationProviderSchema,
    existingMethod: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('password'),
          password: z
            .string()
            .min(1)
            .max(AUTHENTICATION_BOUNDS.passwordCharacters),
        })
        .strict(),
      z
        .object({
          kind: z.literal('social'),
          provider: authenticationProviderSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export const accountSecurityLinkStartResponseSchema = responseSchema(
  authorizationStartedSchema,
);
export const accountSecurityPasswordChangeRequestSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1)
      .max(AUTHENTICATION_BOUNDS.currentPasswordCharacters),
    newPassword: z
      .string()
      .min(AUTHENTICATION_BOUNDS.newPasswordMinimumCharacters)
      .max(AUTHENTICATION_BOUNDS.newPasswordCharacters),
  })
  .strict();
export const accountSecurityPasswordSetupRequestSchema = z
  .object({
    newPassword: z
      .string()
      .min(AUTHENTICATION_BOUNDS.newPasswordMinimumCharacters)
      .max(AUTHENTICATION_BOUNDS.newPasswordCharacters),
  })
  .strict();
export const accountSecurityPasswordChangeResponseSchema = responseSchema(
  z.object({ changed: z.literal(true) }).strict(),
);
export const accountSecurityPasswordSetupResponseSchema = responseSchema(
  z.object({ configured: z.literal(true) }).strict(),
);

export type AuthenticationCapabilitiesResponse = z.output<
  typeof authenticationCapabilitiesResponseSchema
>;
export type AccountSecuritySessionsResponse = z.output<
  typeof accountSecuritySessionsResponseSchema
>;
export type AccountSecurityResponse = z.output<
  typeof accountSecurityResponseSchema
>;
export type AccountSecurityLinkStartRequest = z.input<
  typeof accountSecurityLinkStartRequestSchema
>;

/** Native endpoints may return extra provider fields; these are the owned acknowledgments. */
export const nativeAuthenticationAcknowledgmentSchema = z.object({
  status: z.literal(true),
});
const nativeAuthenticationUserSchema = z.object({ id: z.uuid() });
export const nativeRegistrationResponseSchema = responseSchema(
  z.object({
    user: nativeAuthenticationUserSchema.nullable(),
  }),
);
export const nativeSignInResponseSchema = responseSchema(
  z.union([
    z.object({ twoFactorRedirect: z.literal(true) }),
    z.object({ user: nativeAuthenticationUserSchema }),
  ]),
);
