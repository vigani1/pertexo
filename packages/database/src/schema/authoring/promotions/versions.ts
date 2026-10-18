import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { workflowVersions } from '../workflows.js';

export const workflowVersionPromotions = appSchema.table(
  'workflow_version_promotions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    versionId: uuid('version_id').notNull(),
    sourceWorkspaceId: uuid('source_workspace_id').notNull(),
    sourceWorkflowId: uuid('source_workflow_id').notNull(),
    sourceVersionId: uuid('source_version_id').notNull(),
    sourceChecksum: varchar('source_checksum', { length: 82 }).notNull(),
    promotionId: uuid('promotion_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    primaryKey({
      name: 'workflow_version_promotions_pk',
      columns: [
        table.workspaceId,
        table.versionId,
        table.sourceWorkspaceId,
        table.sourceWorkflowId,
        table.sourceVersionId,
      ],
    }),
    foreignKey({
      name: 'version_promotion_target_fk',
      columns: [table.workspaceId, table.workflowId, table.versionId],
      foreignColumns: [
        workflowVersions.workspaceId,
        workflowVersions.workflowId,
        workflowVersions.id,
      ],
    }).onDelete('cascade'),
    index('version_promotion_source_idx').on(
      table.workspaceId,
      table.sourceWorkspaceId,
      table.sourceWorkflowId,
      table.sourceVersionId,
    ),
    check(
      'version_promotion_checksum_valid',
      sql`source_checksum ~ '^wf:sha256:[a-f0-9]{64}$'`,
    ),
  ],
);
