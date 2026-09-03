import {
  bigint,
  char,
  foreignKey,
  index,
  inet,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';

export const users = appSchema.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: varchar('email', { length: 320 }).notNull(),
    displayName: varchar('display_name', { length: 256 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  () => [],
);
export const authIdentities = appSchema.table(
  'auth_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    issuer: varchar('issuer', { length: 2048 }).notNull(),
    providerSubject: varchar('provider_subject', { length: 255 }).notNull(),
    profileMetadata: jsonb('profile_metadata').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('auth_identities_issuer_subject_unique').on(
      table.issuer,
      table.providerSubject,
    ),
    index('auth_identities_user_idx').on(table.userId, table.id),
  ],
);
export const sessions = appSchema.table(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    tokenDigest: varchar('token_digest', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    userAgent: varchar('user_agent', { length: 512 }),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('sessions_token_digest_unique').on(table.tokenDigest),
    index('sessions_user_active_idx').on(
      table.userId,
      table.expiresAt,
      table.id,
    ),
    index('sessions_expiry_idx').on(table.expiresAt, table.id),
  ],
);
export const oidcLoginTransactions = appSchema.table(
  'oidc_login_transactions',
  {
    stateDigest: varchar('state_digest', { length: 64 }).primaryKey(),
    codeVerifierCiphertext: text('code_verifier_ciphertext').notNull(),
    codeVerifierNonce: varchar('code_verifier_nonce', {
      length: 128,
    }).notNull(),
    codeVerifierTag: varchar('code_verifier_tag', { length: 256 }).notNull(),
    codeVerifierKeyVersion: varchar('code_verifier_key_version', {
      length: 64,
    }).notNull(),
    nonceCiphertext: text('nonce_ciphertext').notNull(),
    nonceNonce: varchar('nonce_nonce', { length: 128 }).notNull(),
    nonceTag: varchar('nonce_tag', { length: 256 }).notNull(),
    nonceKeyVersion: varchar('nonce_key_version', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    consumedAt: timestamp('consumed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('oidc_login_transactions_expiry_idx').on(
      table.expiresAt,
      table.stateDigest,
    ),
  ],
);
export const workspaces = appSchema.table(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 128 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    createdBy: uuid('created_by'),
    deletionRequestedAt: timestamp('deletion_requested_at', {
      withTimezone: true,
      mode: 'date',
    }),
    deletionRequestedBy: uuid('deletion_requested_by'),
    deletionReason: varchar('deletion_reason', { length: 512 }),
    purgeAfter: timestamp('purge_after', { withTimezone: true, mode: 'date' }),
    retentionControlSequence: bigint('retention_control_sequence', {
      mode: 'number',
    })
      .default(0)
      .notNull(),
    retentionControlHash: char('retention_control_hash', { length: 64 })
      .default(sql`repeat('0', 64)`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('workspaces_slug_lower_unique').on(sql`lower(${table.slug})`),
    index('workspaces_status_purge_idx').on(
      table.status,
      table.purgeAfter,
      table.id,
    ),
  ],
);
export const workspaceMemberships = appSchema.table(
  'workspace_memberships',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: varchar('role', { length: 32 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('workspace_memberships_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.userId,
    ),
    index('workspace_memberships_user_idx').on(table.userId, table.workspaceId),
  ],
);
export const auditEvents = appSchema.table(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    actorUserId: uuid('actor_user_id'),
    action: varchar('action', { length: 128 }).notNull(),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: uuid('target_id'),
    requestId: varchar('request_id', { length: 128 }),
    traceId: varchar('trace_id', { length: 128 }),
    metadata: jsonb('metadata').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    index('audit_events_workspace_time_idx').on(
      table.workspaceId,
      table.occurredAt,
      table.id,
    ),
    index('audit_events_workspace_target_idx').on(
      table.workspaceId,
      table.targetType,
      table.targetId,
      table.occurredAt,
    ),
  ],
);
export const usageEvents = appSchema.table(
  'usage_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    category: varchar('category', { length: 64 }).notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    metadata: jsonb('metadata')
      .default(sql`'{}'::jsonb`)
      .notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: 'usage_events_workspace_fk',
    }).onDelete('restrict'),
    uniqueIndex('usage_events_workspace_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index('usage_events_workspace_period_idx').on(
      table.workspaceId,
      table.occurredAt.desc(),
      table.id,
    ),
    index('usage_events_resource_idx').on(
      table.workspaceId,
      table.resourceType,
      table.resourceId,
      table.id,
    ),
  ],
);
export const rlsProbeRecords = appSchema.table(
  'rls_probe_records',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('rls_probe_records_workspace_idx').on(table.workspaceId, table.id),
  ],
);
