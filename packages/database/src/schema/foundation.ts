import {
  type PgTableExtraConfigValue,
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './namespace.js';

export const users = appSchema.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: varchar('email', { length: 320 }).notNull(),
    displayName: varchar('display_name', { length: 256 }).notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    status: varchar('status', { length: 32 })
      .notNull()
      .default(sql`'active'::character varying`),
    profileRevision: integer('profile_revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (): PgTableExtraConfigValue[] => [
    check(
      'users_email_format',
      sql`(((email)::text = btrim((email)::text)) AND ((length((email)::text) >= 3) AND (length((email)::text) <= 320)))`,
    ),
    check('users_profile_revision_positive', sql`(profile_revision > 0)`),
    check(
      'users_status_valid',
      sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text, ('deleted'::character varying)::text]))`,
    ),
    uniqueIndex('users_email_lower_unique').on(sql`lower((email)::text)`),
  ],
);
export const workspaces = appSchema.table(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 128 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 })
      .notNull()
      .default(sql`'active'::character varying`),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by'),
    deletionRequestedAt: timestamp('deletion_requested_at', {
      withTimezone: true,
      mode: 'date',
    }),
    deletionRequestedBy: uuid('deletion_requested_by'),
    deletionReason: varchar('deletion_reason', { length: 512 }),
    purgeAfter: timestamp('purge_after', { withTimezone: true, mode: 'date' }),
    /** ADR 056: failures in a row that pause a workflow's triggers. */
    autoPauseThreshold: smallint('auto_pause_threshold').default(10).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspaces_auto_pause_threshold_valid',
      sql`((auto_pause_threshold >= 3) AND (auto_pause_threshold <= 100))`,
    ),
    check(
      'workspaces_deletion_state_valid',
      sql`((((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text])) AND (created_by IS NOT NULL) AND (deletion_requested_at IS NULL) AND (deletion_requested_by IS NULL) AND (deletion_reason IS NULL) AND (purge_after IS NULL)) OR (((status)::text = ANY (ARRAY[('pending_deletion'::character varying)::text, ('purging'::character varying)::text])) AND (created_by IS NOT NULL) AND (deletion_requested_at IS NOT NULL) AND (deletion_requested_by IS NOT NULL) AND (deletion_reason IS NOT NULL) AND ((length(btrim((deletion_reason)::text)) >= 1) AND (length(btrim((deletion_reason)::text)) <= 512)) AND (purge_after IS NOT NULL) AND (purge_after > deletion_requested_at)) OR (((status)::text = 'deleted'::text) AND (created_by IS NULL) AND (deletion_requested_at IS NOT NULL) AND (deletion_requested_by IS NULL) AND ((deletion_reason)::text = 'purged'::text) AND (purge_after IS NOT NULL) AND (purge_after > deletion_requested_at) AND ((name)::text = 'Deleted workspace'::text) AND ((slug)::text = ('deleted-'::text || (id)::text))))`,
    ),
    check(
      'workspaces_name_nonempty',
      sql`((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 128))`,
    ),
    check('workspaces_revision_positive', sql`(revision > 0)`),
    check(
      'workspaces_slug_format',
      sql`((slug)::text ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text)`,
    ),
    check(
      'workspaces_status_valid',
      sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text, ('pending_deletion'::character varying)::text, ('purging'::character varying)::text, ('deleted'::character varying)::text]))`,
    ),
    foreignKey({
      name: 'workspaces_created_by_fk',
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspaces_deletion_requested_by_fk',
      columns: [table.deletionRequestedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    uniqueIndex('workspaces_slug_lower_unique').on(sql`lower((slug)::text)`),
    index('workspaces_status_purge_idx')
      .on(table.status, table.purgeAfter, table.id)
      .where(
        sql`((status)::text = ANY (ARRAY[('pending_deletion'::character varying)::text, ('purging'::character varying)::text]))`,
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
    status: varchar('status', { length: 32 })
      .notNull()
      .default(sql`'active'::character varying`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_memberships_role_revision_positive',
      sql`(role_revision > 0)`,
    ),
    check(
      'workspace_memberships_role_valid',
      sql`((role)::text = ANY (ARRAY[('owner'::character varying)::text, ('admin'::character varying)::text, ('builder'::character varying)::text, ('operator'::character varying)::text, ('viewer'::character varying)::text]))`,
    ),
    check(
      'workspace_memberships_status_valid',
      sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text, ('removed'::character varying)::text]))`,
    ),
    primaryKey({
      name: 'workspace_memberships_pkey',
      columns: [table.workspaceId, table.userId],
    }),
    foreignKey({
      name: 'workspace_memberships_user_fk',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_memberships_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    uniqueIndex('workspace_memberships_one_owner_unique')
      .on(table.workspaceId)
      .where(
        sql`(((role)::text = 'owner'::text) AND ((status)::text <> 'removed'::text))`,
      ),
    index('workspace_memberships_user_idx').on(table.userId, table.workspaceId),
    index('workspace_memberships_workspace_created_idx')
      .on(table.workspaceId, table.createdAt, table.userId)
      .where(
        sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text]))`,
      ),
    index('workspace_memberships_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.userId,
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
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_invitations_delivery_status_valid',
      sql`((delivery_status)::text = ANY (ARRAY[('queued'::character varying)::text, ('submitted'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text]))`,
    ),
    check(
      'workspace_invitations_normalized_email_valid',
      sql`((normalized_email)::text = lower(btrim((recipient_email)::text)))`,
    ),
    check('workspace_invitations_revision_positive', sql`(revision > 0)`),
    check(
      'workspace_invitations_role_valid',
      sql`((role)::text = ANY (ARRAY[('admin'::character varying)::text, ('builder'::character varying)::text, ('operator'::character varying)::text, ('viewer'::character varying)::text]))`,
    ),
    check(
      'workspace_invitations_status_valid',
      sql`((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('revoked'::character varying)::text, ('expired'::character varying)::text]))`,
    ),
    check(
      'workspace_invitations_terminal_shape',
      sql`((((status)::text = 'accepted'::text) AND (accepted_by IS NOT NULL) AND (accepted_at IS NOT NULL) AND (revoked_at IS NULL)) OR (((status)::text = 'revoked'::text) AND (accepted_by IS NULL) AND (accepted_at IS NULL) AND (revoked_at IS NOT NULL)) OR (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('expired'::character varying)::text])) AND (accepted_by IS NULL) AND (accepted_at IS NULL) AND (revoked_at IS NULL)))`,
    ),
    check(
      'workspace_invitations_token_digest_valid',
      sql`(token_digest ~ '^[0-9a-f]{64}$'::text)`,
    ),
    foreignKey({
      name: 'workspace_invitations_accepted_by_fkey',
      columns: [table.acceptedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_invitations_created_by_fkey',
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_invitations_workspace_id_fkey',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    index('workspace_invitations_expiry_idx')
      .on(table.expiresAt, table.id)
      .where(sql`((status)::text = 'pending'::text)`),
    index('workspace_invitations_list_idx').on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    uniqueIndex('workspace_invitations_pending_recipient_unique')
      .on(table.workspaceId, table.normalizedEmail)
      .where(sql`((status)::text = 'pending'::text)`),
    uniqueIndex('workspace_invitations_token_digest_unique').on(
      table.workspaceId,
      table.id,
      table.tokenDigest,
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
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_invitation_delivery_revision_positive',
      sql`(invitation_revision > 0)`,
    ),
    check(
      'workspace_invitation_delivery_sealed_shape',
      sql`(((token_ciphertext IS NULL) AND (token_nonce IS NULL) AND (token_tag IS NULL) AND (token_key_version IS NULL)) OR ((token_ciphertext IS NOT NULL) AND (token_nonce IS NOT NULL) AND (token_tag IS NOT NULL) AND (token_key_version IS NOT NULL)))`,
    ),
    check(
      'workspace_invitation_delivery_status_valid',
      sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('submitted'::character varying)::text, ('failed'::character varying)::text, ('unknown'::character varying)::text, ('canceled'::character varying)::text]))`,
    ),
    foreignKey({
      name: 'workspace_invitation_delivery_attempts_invitation_id_fkey',
      columns: [table.invitationId],
      foreignColumns: [workspaceInvitations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workspace_invitation_delivery_attempts_workspace_id_fkey',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
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
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_invitation_intents_completion_shape',
      sql`((((status)::text = 'completed'::text) AND (accepted_user_id IS NOT NULL) AND (receipt IS NOT NULL) AND (completed_at IS NOT NULL)) OR (((status)::text <> 'completed'::text) AND (accepted_user_id IS NULL) AND (receipt IS NULL) AND (completed_at IS NULL)))`,
    ),
    check(
      'workspace_invitation_intents_digests_valid',
      sql`((binding_digest ~ '^[0-9a-f]{64}$'::text) AND (csrf_digest ~ '^[0-9a-f]{64}$'::text))`,
    ),
    check(
      'workspace_invitation_intents_revision_positive',
      sql`(invitation_revision > 0)`,
    ),
    check(
      'workspace_invitation_intents_status_valid',
      sql`((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('verified'::character varying)::text, ('wrong_account'::character varying)::text, ('completed'::character varying)::text, ('abandoned'::character varying)::text, ('superseded'::character varying)::text]))`,
    ),
    check(
      'workspace_invitation_intents_verification_shape',
      sql`(((verified_user_id IS NULL) AND (verified_email IS NULL) AND (verified_at IS NULL)) OR ((verified_user_id IS NOT NULL) AND (verified_email IS NOT NULL) AND (verified_at IS NOT NULL)))`,
    ),
    foreignKey({
      name: 'workspace_invitation_acceptance_intents_accepted_user_id_fkey',
      columns: [table.acceptedUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_invitation_acceptance_intents_invitation_id_fkey',
      columns: [table.invitationId],
      foreignColumns: [workspaceInvitations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workspace_invitation_acceptance_intents_verified_user_id_fkey',
      columns: [table.verifiedUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_invitation_acceptance_intents_workspace_id_fkey',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
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
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_invitation_binding_replacement_claims_check',
      sql`((prior_binding_digest ~ '^[0-9a-f]{64}$'::text) AND (successor_binding_digest ~ '^[0-9a-f]{64}$'::text) AND (successor_csrf_digest ~ '^[0-9a-f]{64}$'::text))`,
    ),
    check(
      'workspace_invitation_binding_successor_invitation_revisio_check',
      sql`(successor_invitation_revision > 0)`,
    ),
    primaryKey({
      name: 'workspace_invitation_binding_replacement_claims_pkey',
      columns: [
        table.priorWorkspaceId,
        table.priorIntentId,
        table.priorBindingDigest,
      ],
    }),
    foreignKey({
      name: 'workspace_invitation_binding_replacemen_prior_workspace_id_fkey',
      columns: [table.priorWorkspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    index('workspace_invitation_binding_replacement_cleanup_idx').on(
      table.updatedAt,
      table.priorWorkspaceId,
      table.priorIntentId,
    ),
    index('workspace_invitation_binding_replacement_successor_idx').on(
      table.successorWorkspaceId,
      table.successorIntentId,
      table.successorBindingDigest,
    ),
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
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'audit_events_action_format',
      sql`((action)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)`,
    ),
    check(
      'audit_events_metadata_bounded',
      sql`(octet_length((metadata)::text) <= 8192)`,
    ),
    check(
      'audit_events_preview_terminal_uuid_v7',
      sql`(((action)::text <> 'preview.execution_terminal'::text) OR (uuid_extract_version(id) = 7))`,
    ),
    check(
      'audit_events_request_id_bounded',
      sql`((request_id IS NULL) OR ((length((request_id)::text) >= 1) AND (length((request_id)::text) <= 128)))`,
    ),
    check(
      'audit_events_target_type_format',
      sql`((target_type)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text)`,
    ),
    check(
      'audit_events_trace_id_bounded',
      sql`((trace_id IS NULL) OR ((length((trace_id)::text) >= 1) AND (length((trace_id)::text) <= 128)))`,
    ),
    foreignKey({
      name: 'audit_events_actor_fk',
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'audit_events_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    index('audit_events_workspace_target_idx').on(
      table.workspaceId,
      table.targetType,
      table.targetId,
      table.occurredAt.desc().nullsFirst(),
    ),
    index('audit_events_workspace_time_idx').on(
      table.workspaceId,
      table.occurredAt.desc().nullsFirst(),
      table.id,
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
  (table): PgTableExtraConfigValue[] => [
    check(
      'usage_events_category_format',
      sql`((category)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text)`,
    ),
    check(
      'usage_events_idempotency_key_format',
      sql`((idempotency_key)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text)`,
    ),
    check(
      'usage_events_metadata_bounded',
      sql`(octet_length((metadata)::text) <= 4096)`,
    ),
    check(
      'usage_events_preview_uuid_v7',
      sql`(((category)::text <> 'preview_execution'::text) OR (uuid_extract_version(id) = 7))`,
    ),
    check('usage_events_quantity_positive', sql`(quantity > 0)`),
    check(
      'usage_events_resource_type_format',
      sql`((resource_type)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text)`,
    ),
    unique('usage_events_workspace_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: 'usage_events_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    index('usage_events_resource_idx').on(
      table.workspaceId,
      table.resourceType,
      table.resourceId,
      table.id,
    ),
    index('usage_events_workspace_period_idx').on(
      table.workspaceId,
      table.occurredAt.desc().nullsFirst(),
      table.id,
    ),
  ],
);

export const workspaceLifecycleOperations = appSchema.table(
  'workspace_lifecycle_operations',
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    idempotencyKeyHash: char('idempotency_key_hash', { length: 64 }).notNull(),
    commandType: varchar('command_type', { length: 32 }).notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    reason: varchar({ length: 512 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_lifecycle_operations_command_valid',
      sql`((command_type)::text = ANY (ARRAY[('deletion_requested'::character varying)::text, ('deletion_restored'::character varying)::text]))`,
    ),
    check(
      'workspace_lifecycle_operations_idempotency_hash_valid',
      sql`(idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'workspace_lifecycle_operations_reason_bounded',
      sql`((length(btrim((reason)::text)) >= 1) AND (length(btrim((reason)::text)) <= 512))`,
    ),
    check(
      'workspace_lifecycle_operations_request_hash_valid',
      sql`(request_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    unique('workspace_lifecycle_operations_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKeyHash,
    ),
    foreignKey({
      name: 'workspace_lifecycle_operations_actor_fk',
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_lifecycle_operations_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
  ],
);

export const workspaceInboxRevisionSequence = appSchema.sequence(
  'workspace_inbox_revision_seq',
);
