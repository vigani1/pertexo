import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { users } from '../../identity/users.js';
import { workspaces } from '../workspaces.js';
import { workspaceInvitations } from './invitations.js';

export const workspaceInvitationAcceptanceIntents = appSchema.table(
  'workspace_invitation_acceptance_intents',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    invitationId: uuid('invitation_id').notNull(),
    invitationRevision: integer('invitation_revision').notNull(),
    bindingDigest: char('binding_digest', { length: 64 }).notNull(),
    csrfDigest: char('csrf_digest', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 })
      .$type<
        | 'pending'
        | 'verified'
        | 'wrong_account'
        | 'completed'
        | 'abandoned'
        | 'superseded'
      >()
      .notNull()
      .default('pending'),
    verifiedUserId: uuid('verified_user_id'),
    verifiedSessionId: uuid('verified_session_id'),
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
