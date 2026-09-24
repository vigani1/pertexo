import {
  bigint,
  boolean,
  char,
  foreignKey,
  index,
  integer,
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
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
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
export const workspaces = appSchema.table(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 128 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    revision: integer('revision').notNull().default(1),
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
    roleRevision: integer('role_revision').notNull().default(1),
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
    index('workspace_memberships_workspace_created_idx')
      .on(table.workspaceId, table.createdAt, table.userId)
      .where(sql`${table.status} in ('active', 'suspended')`),
  ],
);

export const workspaceMemberRoleCommandReceipts = appSchema.table(
  'workspace_member_role_command_receipts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    targetUserId: uuid('target_user_id').notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    resultRef: jsonb('result_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('workspace_member_role_command_receipts_key_unique').on(
      table.actorUserId,
      table.workspaceId,
      table.keyHash,
    ),
    index('workspace_member_role_command_receipts_workspace_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const workspaceRenameCommandReceipts = appSchema.table(
  'workspace_rename_command_receipts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    resultRef: jsonb('result_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('workspace_rename_command_receipts_key_unique').on(
      table.actorUserId,
      table.workspaceId,
      table.keyHash,
    ),
    index('workspace_rename_command_receipts_workspace_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const workspaceInvitations = appSchema.table(
  'workspace_invitations',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    recipientEmail: varchar('recipient_email', { length: 320 }).notNull(),
    normalizedEmail: varchar('normalized_email', { length: 320 }).notNull(),
    role: varchar('role', { length: 32 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    revision: integer('revision').notNull().default(1),
    tokenDigest: char('token_digest', { length: 64 }).notNull(),
    deliveryStatus: varchar('delivery_status', { length: 32 })
      .notNull()
      .default('queued'),
    createdBy: uuid('created_by').notNull(),
    acceptedBy: uuid('accepted_by'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('workspace_invitations_pending_recipient_unique')
      .on(table.workspaceId, table.normalizedEmail)
      .where(sql`${table.status}='pending'`),
    uniqueIndex('workspace_invitations_token_digest_unique').on(
      table.workspaceId,
      table.id,
      table.tokenDigest,
    ),
    index('workspace_invitations_list_idx').on(
      table.workspaceId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('workspace_invitations_expiry_idx')
      .on(table.expiresAt, table.id)
      .where(sql`${table.status}='pending'`),
  ],
);

export const workspaceInvitationCommandReceipts = appSchema.table(
  'workspace_invitation_command_receipts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    operation: varchar('operation', { length: 32 }).notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    resultRef: jsonb('result_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('workspace_invitation_receipts_key_unique').on(
      table.actorUserId,
      table.workspaceId,
      table.operation,
      table.keyHash,
    ),
    index('workspace_invitation_receipts_workspace_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const workspaceInvitationDeliveryAttempts = appSchema.table(
  'workspace_invitation_delivery_attempts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    invitationId: uuid('invitation_id').notNull(),
    invitationRevision: integer('invitation_revision').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('queued'),
    tokenCiphertext: text('token_ciphertext'),
    tokenNonce: varchar('token_nonce', { length: 128 }),
    tokenTag: varchar('token_tag', { length: 256 }),
    tokenKeyVersion: varchar('token_key_version', { length: 64 }),
    workspaceName: varchar('workspace_name', { length: 256 }).notNull(),
    providerReference: varchar('provider_reference', { length: 512 }),
    failureCode: varchar('failure_code', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('workspace_invitation_delivery_generation_unique').on(
      table.invitationId,
      table.invitationRevision,
    ),
    index('workspace_invitation_delivery_workspace_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const workspaceInvitationAcceptanceIntents = appSchema.table(
  'workspace_invitation_acceptance_intents',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    invitationId: uuid('invitation_id').notNull(),
    invitationRevision: integer('invitation_revision').notNull(),
    bindingDigest: char('binding_digest', { length: 64 }).notNull(),
    csrfDigest: char('csrf_digest', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    verifiedUserId: uuid('verified_user_id'),
    verifiedEmail: varchar('verified_email', { length: 320 }),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    acceptedUserId: uuid('accepted_user_id'),
    receipt: jsonb('receipt'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    abandonedAt: timestamp('abandoned_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('workspace_invitation_intents_binding_unique').on(
      table.workspaceId,
      table.bindingDigest,
    ),
    index('workspace_invitation_intents_expiry_idx').on(
      table.expiresAt,
      table.id,
    ),
    index('workspace_invitation_intents_invitation_idx').on(
      table.workspaceId,
      table.invitationId,
      table.invitationRevision,
      table.id,
    ),
  ],
);
export const workspaceInvitationBindingReplacementClaims = appSchema.table(
  'workspace_invitation_binding_replacement_claims',
  {
    priorWorkspaceId: uuid('prior_workspace_id').notNull(),
    priorIntentId: uuid('prior_intent_id').notNull(),
    priorBindingDigest: char('prior_binding_digest', { length: 64 }).notNull(),
    successorWorkspaceId: uuid('successor_workspace_id').notNull(),
    successorIntentId: uuid('successor_intent_id').notNull(),
    successorInvitationId: uuid('successor_invitation_id').notNull(),
    successorInvitationRevision: integer(
      'successor_invitation_revision',
    ).notNull(),
    successorBindingDigest: char('successor_binding_digest', {
      length: 64,
    }).notNull(),
    successorCsrfDigest: char('successor_csrf_digest', {
      length: 64,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.priorWorkspaceId,
        table.priorIntentId,
        table.priorBindingDigest,
      ],
    }),
    index('workspace_invitation_binding_replacement_successor_idx').on(
      table.successorWorkspaceId,
      table.successorIntentId,
      table.successorBindingDigest,
    ),
    index('workspace_invitation_binding_replacement_cleanup_idx').on(
      table.updatedAt,
      table.priorWorkspaceId,
      table.priorIntentId,
    ),
  ],
);
export const workspaceInvitationClaimCleanupCursors = appSchema.table(
  'workspace_invitation_claim_cleanup_cursors',
  {
    scanKind: varchar('scan_kind', { length: 32 }).notNull(),
    scanId: uuid('scan_id').notNull(),
    workspaceId: uuid('workspace_id'),
    purgeJobId: uuid('purge_job_id'),
    cursorUpdatedAt: timestamp('cursor_updated_at', {
      withTimezone: true,
      mode: 'date',
    }),
    cursorPriorWorkspaceId: uuid('cursor_prior_workspace_id'),
    cursorPriorIntentId: uuid('cursor_prior_intent_id'),
    cursorPriorBindingDigest: char('cursor_prior_binding_digest', {
      length: 64,
    }),
    highWaterUpdatedAt: timestamp('high_water_updated_at', {
      withTimezone: true,
      mode: 'date',
    }),
    highWaterPriorWorkspaceId: uuid('high_water_prior_workspace_id'),
    highWaterPriorIntentId: uuid('high_water_prior_intent_id'),
    highWaterPriorBindingDigest: char('high_water_prior_binding_digest', {
      length: 64,
    }),
    cycleCompleted: boolean('cycle_completed').default(false).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.scanKind, table.scanId] })],
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
