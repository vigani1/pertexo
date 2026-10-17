import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { users } from '../foundation.js';
import { workflows, workflowVersions } from './workflows.js';

export const workflowPublicationRequests = appSchema.table(
  'workflow_publication_requests',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: uuid('id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    draftRevision: integer('draft_revision').notNull(),
    representationTag: varchar('representation_tag', { length: 64 }).notNull(),
    note: varchar('note', { length: 1000 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    comment: varchar('comment', { length: 1000 }),
    publishedVersionId: uuid('published_version_id'),
    reused: boolean('reused'),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: 'publication_requests_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'publication_requests_requester_fk',
      columns: [table.requestedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'publication_requests_decider_fk',
      columns: [table.decidedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'publication_requests_version_fk',
      columns: [table.workspaceId, table.workflowId, table.publishedVersionId],
      foreignColumns: [
        workflowVersions.workspaceId,
        workflowVersions.workflowId,
        workflowVersions.id,
      ],
    }).onDelete('restrict'),
    check(
      'publication_requests_revision_valid',
      sql`draft_revision>0 AND representation_tag ~ '^"draft[.][A-Za-z0-9_-]{43}"$'`,
    ),
    check(
      'publication_requests_note_valid',
      sql`length(btrim(note)) between 1 and 1000`,
    ),
    check(
      'publication_requests_status_valid',
      sql`status in ('pending','approved','rejected','stale')`,
    ),
    check('publication_requests_expiry_valid', sql`expires_at>created_at`),
    check(
      'publication_requests_decision_valid',
      sql`((status in ('pending','stale') AND decided_by IS NULL AND decided_at IS NULL AND comment IS NULL AND published_version_id IS NULL AND reused IS NULL) OR (status='rejected' AND decided_by IS NOT NULL AND decided_by<>requested_by AND decided_at IS NOT NULL AND published_version_id IS NULL AND reused IS NULL) OR (status='approved' AND decided_by IS NOT NULL AND decided_by<>requested_by AND decided_at IS NOT NULL AND published_version_id IS NOT NULL AND reused IS NOT NULL)) IS TRUE`,
    ),
    uniqueIndex('publication_requests_pending_unique')
      .on(table.workspaceId, table.workflowId)
      .where(sql`status='pending'`),
    index('publication_requests_recent_idx').on(
      table.workspaceId,
      table.workflowId,
      table.createdAt,
      table.id,
    ),
    index('publication_requests_expiry_idx').on(table.expiresAt, table.id),
  ],
);
