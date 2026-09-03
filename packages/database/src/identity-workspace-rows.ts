import { z } from 'zod';

import type {
  AuthIdentityRecord,
  SessionRecord,
  UserRecord,
  WorkspaceLifecycleOperation,
  WorkspaceRecord,
} from './identity-workspace.js';

const uuidSchema = z.uuid();
const metadataSchema = z
  .record(z.string(), z.json())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 8192);
const userRowSchema = z
  .object({
    id: uuidSchema,
    email: z.string().trim().min(3).max(320),
    display_name: z.string().trim().min(1).max(256),
    status: z.enum(['active', 'suspended', 'deleted']),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .strict();
const authIdentityRowSchema = z
  .object({
    id: uuidSchema,
    user_id: uuidSchema,
    issuer: z.url().max(2048),
    provider_subject: z.string().min(1).max(255),
    profile_metadata: metadataSchema,
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .strict();
const sessionRowSchema = z
  .object({
    id: uuidSchema,
    user_id: uuidSchema,
    token_digest: z.string().regex(/^[0-9a-f]{64}$/u),
    expires_at: z.coerce.date(),
    revoked_at: z.coerce.date().nullable(),
    user_agent: z.string().max(512).nullable(),
    ip_address: z.string().nullable(),
    created_at: z.coerce.date(),
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
    created_by: uuidSchema,
    deletion_requested_at: z.coerce.date().nullable(),
    deletion_requested_by: uuidSchema.nullable(),
    deletion_reason: z.string().trim().min(1).max(512).nullable(),
    purge_after: z.coerce.date().nullable(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .strict();
const lifecycleOperationRowSchema = z
  .object({
    operation_id: uuidSchema,
    workspace_id: uuidSchema,
    command_type: z.enum(['deletion_requested', 'deletion_restored']),
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    occurred_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    completed_at: z.coerce.date().nullable(),
    error_code: z.string().nullable(),
  })
  .strict();

export const workspaceLifecycleOperationRowSelection =
  'operation_id,workspace_id,command_type,status,occurred_at,error_code,updated_at,completed_at';

export function mapUser(row: Record<string, unknown>): UserRecord {
  const parsed = userRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    email: parsed.email,
    displayName: parsed.display_name,
    status: parsed.status,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}

export function mapAuthIdentity(
  row: Record<string, unknown>,
): AuthIdentityRecord {
  const parsed = authIdentityRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    userId: parsed.user_id,
    issuer: parsed.issuer,
    providerSubject: parsed.provider_subject,
    profileMetadata: parsed.profile_metadata,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}

export function mapSession(row: Record<string, unknown>): SessionRecord {
  const parsed = sessionRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    userId: parsed.user_id,
    tokenDigest: parsed.token_digest,
    expiresAt: parsed.expires_at,
    revokedAt: parsed.revoked_at,
    userAgent: parsed.user_agent,
    ipAddress: parsed.ip_address,
    createdAt: parsed.created_at,
  });
}

export function mapWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  const parsed = workspaceRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    name: parsed.name,
    slug: parsed.slug,
    status: parsed.status,
    createdBy: parsed.created_by,
    deletionRequestedAt: parsed.deletion_requested_at,
    deletionRequestedBy: parsed.deletion_requested_by,
    deletionReason: parsed.deletion_reason,
    purgeAfter: parsed.purge_after,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}

export function mapWorkspaceLifecycleOperation(
  row: Record<string, unknown>,
): WorkspaceLifecycleOperation {
  const parsed = lifecycleOperationRowSchema.parse(row);
  return Object.freeze({
    id: parsed.operation_id,
    workspaceId: parsed.workspace_id,
    commandType: parsed.command_type,
    status: parsed.status,
    submittedAt: parsed.occurred_at,
    updatedAt: parsed.updated_at,
    completedAt: parsed.completed_at,
    errorCode: parsed.error_code,
  });
}
