import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { users } from '../identity/users.js';

export const workspaces = appSchema.table(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 128 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 })
      .$type<
        'active' | 'suspended' | 'pending_deletion' | 'purging' | 'deleted'
      >()
      .notNull()
      .default(sql`'active'::character varying`),
    revision: integer('revision').notNull().default(1),
    auditRetentionDays: smallint('audit_retention_days').notNull().default(365),
    governanceRevision: integer('governance_revision').notNull().default(1),
    requirePublishApproval: boolean('require_publish_approval')
      .notNull()
      .default(false),
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
      'workspaces_audit_retention_valid',
      sql`audit_retention_days between 30 and 2555`,
    ),
    check(
      'workspaces_governance_revision_positive',
      sql`governance_revision > 0`,
    ),
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
