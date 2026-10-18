import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { users, workspaces } from '../../foundation.js';

export const workspacePromotionTargets = appSchema.table(
  'workspace_promotion_targets',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    targetWorkspaceId: uuid('target_workspace_id'),
    revision: integer('revision').notNull().default(1),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    foreignKey({
      name: 'promotion_target_source_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'promotion_target_destination_fk',
      columns: [table.targetWorkspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'promotion_target_actor_fk',
      columns: [table.updatedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    check('promotion_target_distinct', sql`workspace_id<>target_workspace_id`),
    check('promotion_target_revision_positive', sql`revision>0`),
  ],
);
