import { z } from 'zod';

import type { UserRecord, WorkspaceRecord } from './contracts.js';

const uuidSchema = z.uuid();
const userRowSchema = z
  .object({
    id: uuidSchema,
    email: z.string().trim().min(3).max(320),
    display_name: z.string().trim().min(1).max(256),
    status: z.enum(['active', 'suspended', 'deleted']),
    profile_revision: z.number().int().positive(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .strict();
const workspaceRowSchema = z
  .object({
    id: uuidSchema,
    name: z.string().trim().min(1).max(128),
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
    status: z.enum([
      'active',
      'suspended',
      'pending_deletion',
      'purging',
      'deleted',
    ]),
    revision: z.number().int().positive(),
    created_by: uuidSchema,
    deletion_requested_at: z.coerce.date().nullable(),
    deletion_requested_by: uuidSchema.nullable(),
    deletion_reason: z.string().trim().min(1).max(512).nullable(),
    purge_after: z.coerce.date().nullable(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .strict();
export function mapUser(row: Record<string, unknown>): UserRecord {
  const parsed = userRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    email: parsed.email,
    displayName: parsed.display_name,
    status: parsed.status,
    profileRevision: parsed.profile_revision,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}

export function mapWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  const parsed = workspaceRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    name: parsed.name,
    slug: parsed.slug,
    status: parsed.status,
    revision: parsed.revision,
    createdBy: parsed.created_by,
    deletionRequestedAt: parsed.deletion_requested_at,
    deletionRequestedBy: parsed.deletion_requested_by,
    deletionReason: parsed.deletion_reason,
    purgeAfter: parsed.purge_after,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}
