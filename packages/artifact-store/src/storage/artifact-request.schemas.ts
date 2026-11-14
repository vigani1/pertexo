import { z } from 'zod';

import { artifactIdentitySchema } from '../artifact-identity.js';

/** The most object versions one purge page lists and deletes. */
const MAX_PURGE_PAGE_OBJECTS = 500;

// RFC 6838: a type and subtype of at most 127 characters each, and a slash.
const MEDIA_TYPE_LENGTH = Object.freeze({ min: 3, max: 255 });

/** How long a signed upload or download address stays valid. */
export const SIGNED_URL_LIFETIME_SECONDS = Object.freeze({
  min: 60,
  max: 15 * 60,
});

export const purgeWorkspaceSchema = z.object({
  maxObjects: z.number().int().min(1).max(MAX_PURGE_PAGE_OBJECTS),
  workspaceId: z.uuid(),
});

export const metadataSchema = artifactIdentitySchema.extend({
  byteLength: z.number().int().nonnegative(),
  mediaType: z
    .string()
    .trim()
    .min(MEDIA_TYPE_LENGTH.min)
    .max(MEDIA_TYPE_LENGTH.max)
    .regex(/^[^\s/;]+\/[^\r\n]+$/u)
    .regex(/^[\t\x20-\x7e\x80-\xff]+$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const beginDirectUploadSchema = metadataSchema.extend({
  expiresInSeconds: z
    .number()
    .int()
    .min(SIGNED_URL_LIFETIME_SECONDS.min)
    .max(SIGNED_URL_LIFETIME_SECONDS.max),
});
