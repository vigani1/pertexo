import {
  API_TOKEN_SCOPES,
  API_TOKEN_DEFAULT_LIFETIME_DAYS,
  API_TOKEN_MAX_LIFETIME_DAYS,
  API_TOKEN_ACTIVE_LIMIT,
  apiTokenCredentialSchema,
} from '@pertexo/workflow-model';
export {
  API_TOKEN_SCOPES,
  API_TOKEN_DEFAULT_LIFETIME_DAYS,
  API_TOKEN_MAX_LIFETIME_DAYS,
  API_TOKEN_ACTIVE_LIMIT,
  apiTokenCredentialSchema,
};
import { z } from 'zod';

export const apiTokenScopeSchema = z.enum(API_TOKEN_SCOPES);
export type ApiTokenScope = z.output<typeof apiTokenScopeSchema>;

const scopes = z
  .array(apiTokenScopeSchema)
  .min(1)
  .max(API_TOKEN_SCOPES.length)
  .refine(
    (values) => new Set(values).size === values.length,
    'Scopes must be unique',
  );
export const apiTokenCreateRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^\P{Cc}+$/u),
    scopes: scopes.transform((values) => values.toSorted()),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(API_TOKEN_MAX_LIFETIME_DAYS)
      .default(API_TOKEN_DEFAULT_LIFETIME_DAYS),
  })
  .strict();
const apiTokenMetadataFields = {
  id: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string().min(1).max(128),
  scopes,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
};
// A token has a revocation time exactly when it is revoked.
export const apiTokenMetadataSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...apiTokenMetadataFields,
      status: z.literal('revoked'),
      revokedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      ...apiTokenMetadataFields,
      status: z.enum(['active', 'expired', 'membership_changed']),
      revokedAt: z.null(),
    })
    .strict(),
]);
export const apiTokenCreateResponseSchema = z.discriminatedUnion('replayed', [
  z
    .object({
      token: apiTokenMetadataSchema,
      replayed: z.literal(false),
      secret: apiTokenCredentialSchema,
    })
    .strict(),
  z
    .object({ token: apiTokenMetadataSchema, replayed: z.literal(true) })
    .strict(),
]);
export const apiTokenListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    after: z.uuid().optional(),
  })
  .strict();
export const apiTokenListResponseSchema = z
  .object({
    enabled: z.boolean(),
    availableScopes: z.array(apiTokenScopeSchema).max(API_TOKEN_SCOPES.length),
    items: z.array(apiTokenMetadataSchema).max(50),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
export const apiTokenRevokeRequestSchema = z.object({}).strict();
export const apiTokenRevokeResponseSchema = z
  .object({ token: apiTokenMetadataSchema, replayed: z.boolean() })
  .strict();
export type ApiTokenCreateRequest = z.output<
  typeof apiTokenCreateRequestSchema
>;
export type ApiTokenCreateResponse = z.output<
  typeof apiTokenCreateResponseSchema
>;
export type ApiTokenMetadata = z.output<typeof apiTokenMetadataSchema>;
export type ApiTokenListResponse = z.output<typeof apiTokenListResponseSchema>;
export type ApiTokenRevokeResponse = z.output<
  typeof apiTokenRevokeResponseSchema
>;
