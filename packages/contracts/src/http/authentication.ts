import { z } from 'zod';

export const oidcAuthorizationCodeSchema = z.string().min(1).max(4_096);
export const oidcStateSchema = z.string().min(16).max(512);
/** OAuth callback wire input: validate known fields and ignore extensions. */
export const oidcCallbackRequestSchema = z
  .object({ code: oidcAuthorizationCodeSchema, state: oidcStateSchema })
  .strip();
export const oidcStartResponseSchema = z
  .object({ authorizationUrl: z.url(), expiresAt: z.iso.datetime() })
  .strict();
/**
 * Where a sign-in may return. Only same-origin app paths matching these
 * known routes are accepted: no scheme, host, `//`, query or fragment.
 */
const AUTHENTICATION_RETURN_PATHS = Object.freeze([
  /^\/invitations\/accept$/u,
  /^\/account\/security$/u,
  /^\/w\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/account$/u,
]);
export const authenticationReturnPathSchema = z
  .string()
  .max(128)
  .refine((path) =>
    AUTHENTICATION_RETURN_PATHS.some((pattern) => pattern.test(path)),
  );
export const authenticationProviderSchema = z.enum([
  'google',
  'microsoft',
  'github',
  'apple',
]);
export const authenticationCapabilitiesResponseSchema = z
  .object({
    password: z
      .object({
        enabled: z.boolean(),
        minimumLength: z.number().int().min(8).max(128),
        verificationRequired: z.boolean(),
      })
      .strict(),
    socialProviders: z.array(authenticationProviderSchema).max(4),
    legacyMigrationAvailable: z.boolean().default(false),
  })
  .strict();
export const accountSecuritySessionSchema = z
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
export const accountSecuritySessionsResponseSchema = z
  .object({ items: z.array(accountSecuritySessionSchema).max(100) })
  .strict();
export const accountSecuritySessionRevokeRequestSchema = z
  .object({ sessionId: z.uuid() })
  .strict();
export const accountSecuritySessionRevokeResponseSchema = z
  .object({ revoked: z.boolean() })
  .strict();
export const accountSecurityRevokeOthersResponseSchema = z
  .object({ revokedCount: z.number().int().nonnegative() })
  .strict();
export const accountSecurityMethodSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['password', 'social']),
    provider: z.string().min(1).max(64).nullable(),
  })
  .strict();
export const accountSecurityResponseSchema = z
  .object({
    email: z.email().max(320),
    emailVerified: z.boolean(),
    availableProviders: z.array(authenticationProviderSchema).max(4),
    methods: z.array(accountSecurityMethodSchema).max(16),
  })
  .strict();
export const accountSecurityMethodUnlinkRequestSchema = z
  .object({ methodId: z.uuid() })
  .strict();
export const accountSecurityMethodUnlinkResponseSchema = z
  .object({ unlinked: z.literal(true) })
  .strict();
export const accountSecurityLinkStartRequestSchema = z
  .object({
    provider: authenticationProviderSchema,
    existingMethod: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('password'),
          password: z.string().min(1).max(128),
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
export const accountSecurityLinkStartResponseSchema = z
  .object({ authorizationUrl: z.url() })
  .strict();
export const legacyMethodMigrationStartRequestSchema = z
  .object({ provider: authenticationProviderSchema })
  .strict();
export const legacyMethodMigrationStartResponseSchema = z
  .object({ authorizationUrl: z.url(), expiresAt: z.iso.datetime() })
  .strict();
export const accountSecurityPasswordChangeRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(12).max(128),
  })
  .strict();
export const accountSecurityPasswordSetupRequestSchema = z
  .object({ newPassword: z.string().min(12).max(128) })
  .strict();
export const accountSecurityPasswordChangeResponseSchema = z
  .object({ changed: z.literal(true) })
  .strict();
export const accountSecurityPasswordSetupResponseSchema = z
  .object({ configured: z.literal(true) })
  .strict();

export type AuthenticationReturnPath = z.output<
  typeof authenticationReturnPathSchema
>;
export type AuthenticationCapabilitiesResponse = z.output<
  typeof authenticationCapabilitiesResponseSchema
>;
export type AccountSecuritySession = z.output<
  typeof accountSecuritySessionSchema
>;
export type AccountSecuritySessionsResponse = z.output<
  typeof accountSecuritySessionsResponseSchema
>;
export type AccountSecuritySessionRevokeRequest = z.input<
  typeof accountSecuritySessionRevokeRequestSchema
>;
export type AccountSecurityResponse = z.output<
  typeof accountSecurityResponseSchema
>;
export type AccountSecurityLinkStartRequest = z.input<
  typeof accountSecurityLinkStartRequestSchema
>;
