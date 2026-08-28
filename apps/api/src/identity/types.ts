import { z } from 'zod';

export const oidcConfigurationSchema = z.object({
  issuer: z.url(),
  authorizationEndpoint: z.url(),
  clientId: z.string().trim().min(1).max(256),
  redirectUri: z.url(),
  scopes: z
    .array(z.string().trim().min(1).max(64))
    .min(1)
    .max(16)
    .default(['openid']),
  transactionTtlMillis: z
    .number()
    .int()
    .positive()
    .max(10 * 60_000)
    .default(5 * 60_000),
});

export type OidcConfiguration = Readonly<
  Omit<z.output<typeof oidcConfigurationSchema>, 'scopes'> & {
    scopes: readonly string[];
  }
>;

export const oidcCallbackInputSchema = z.object({
  code: z.string().min(1).max(4_096),
  state: z.string().min(16).max(512),
});

export type OidcCallbackInput = Readonly<
  z.infer<typeof oidcCallbackInputSchema>
>;

export type OidcLoginTransaction = Readonly<{
  stateDigest: string;
  browserBindingDigest: string;
  codeVerifier: string;
  nonce: string;
  expiresAt: Date;
}>;

export type ExternalIdentity = Readonly<{
  issuer: string;
  subject: string;
}>;

export type VerifiedOidcProfile = Readonly<{
  email: string;
  displayName: string;
  emailVerified?: boolean;
}>;

export type InternalIdentity = Readonly<{
  userId: string;
  authenticationIdentityId?: string;
}>;

export const internalIdentitySchema = z
  .object({
    userId: z.uuid(),
    authenticationIdentityId: z.uuid().optional(),
  })
  .strict();

export type SafeClientMetadata = Readonly<{
  userAgent?: string;
  ipAddress?: string;
  requestId?: string;
}>;

const safeBoundedText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) => {
        for (const character of value) {
          const code = character.codePointAt(0) ?? 0;
          if (code < 0x20 || code === 0x7f) return false;
        }
        return true;
      },
      { message: 'control characters are not allowed' },
    );

export const safeClientMetadataSchema = z
  .object({
    userAgent: safeBoundedText(256).optional(),
    ipAddress: safeBoundedText(64).optional(),
    requestId: z
      .string()
      .trim()
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
      .optional(),
  })
  .strict();

export type SessionRecord = Readonly<{
  sessionId: string;
  tokenDigest: string;
  userId: string;
  expiresAt: Date;
  revokedAt?: Date;
  clientMetadata: SafeClientMetadata;
}>;

export type SessionLookup = Readonly<{
  userId: string;
  sessionId: string;
  expiresAt: Date;
  clientMetadata: SafeClientMetadata;
}>;

export type SessionCookieOptions = Readonly<{
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: '/';
  maxAgeSeconds: number;
}>;

export const sessionRecordSchema = z
  .object({
    sessionId: z.uuid(),
    tokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    userId: z.uuid(),
    expiresAt: z.date().refine((value) => Number.isFinite(value.getTime())),
    revokedAt: z
      .date()
      .refine((value) => Number.isFinite(value.getTime()))
      .optional(),
    clientMetadata: safeClientMetadataSchema,
  })
  .strict();
