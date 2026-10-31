import { z } from 'zod';

export const connectionIdentifierSchema = z.uuid();
export const connectionSecretVersionIdentifierSchema = z.uuid();
const connectionProviderKeySchema = z.enum([
  'http',
  'slack',
  'email',
  'signing',
]);
const connectionAuthTypeSchema = z.enum([
  'hmac_key',
  'http_headers',
  'slack_bot_token',
  'resend_api_key',
  'oauth2',
]);
export const connectionStatusSchema = z.enum([
  'active',
  'reauthorization_required',
  'revoked',
]);
export const connectionNameSchema = z.string().trim().min(1).max(128);

/** The fields every connection answers with; an OAuth2 connection narrows them. */
export const connectionResponseFields = {
  id: connectionIdentifierSchema,
  workspaceId: z.uuid(),
  providerKey: connectionProviderKeySchema,
  name: connectionNameSchema,
  authType: connectionAuthTypeSchema,
  status: connectionStatusSchema,
  secretVersionId: connectionSecretVersionIdentifierSchema,
  health: z
    .object({
      lastTestedAt: z.iso.datetime().nullable(),
      lastHealthyAt: z.iso.datetime().nullable(),
      lastErrorCode: z.string().min(1).max(128).nullable(),
      lastRunObservedAt: z.iso.datetime().nullable().optional(),
      lastHealthTransitionAt: z.iso.datetime().nullable().optional(),
      lastHealthTransitionSource: z
        .enum(['run', 'test', 'rotation', 'revoke'])
        .nullable()
        .optional(),
    })
    .strict()
    .readonly(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Omitted means everyone in the workspace; who can use it stays on the sharing read. */
  accessMode: z.enum(['workspace', 'restricted']).optional(),
} as const;
