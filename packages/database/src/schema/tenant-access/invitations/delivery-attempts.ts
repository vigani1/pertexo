import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { workspaces } from '../workspaces.js';
import { workspaceInvitations } from './invitations.js';

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
