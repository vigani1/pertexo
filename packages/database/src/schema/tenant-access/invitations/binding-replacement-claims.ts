import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { workspaces } from '../workspaces.js';

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
