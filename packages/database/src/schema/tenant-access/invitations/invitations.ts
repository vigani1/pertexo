import type { DelegatedRole } from '@pertexo/policy';
import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  foreignKey,
  index,
  integer,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { users } from '../../identity/users.js';
import { workspaces } from '../workspaces.js';

export const workspaceInvitations = appSchema.table(
  'workspace_invitations',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    recipientEmail: varchar('recipient_email', { length: 320 }).notNull(),
    normalizedEmail: varchar('normalized_email', { length: 320 }).notNull(),
    role: varchar('role', { length: 32 }).$type<DelegatedRole>().notNull(),
    status: varchar('status', { length: 32 })
      .$type<'pending' | 'accepted' | 'revoked' | 'expired'>()
      .notNull()
      .default('pending'),
    revision: integer('revision').notNull().default(1),
    tokenDigest: char('token_digest', { length: 64 }).notNull(),
    deliveryStatus: varchar('delivery_status', { length: 32 })
      .$type<'queued' | 'submitted' | 'failed' | 'canceled' | 'unknown'>()
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
      sql`((delivery_status)::text = ANY (ARRAY[('queued'::character varying)::text, ('submitted'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('unknown'::character varying)::text]))`,
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
