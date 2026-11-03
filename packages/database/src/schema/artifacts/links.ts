import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  index,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';
import { previewRuns } from '../previews/runs.js';
import { artifacts } from './artifacts.js';

export const artifactLinks = appSchema.table(
  'artifact_links',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: uuid('artifact_id').notNull(),
    ownerKind: varchar('owner_kind', { length: 32 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'artifact_links_owner_kind_valid',
      sql`((owner_kind)::text = 'preview_run'::text)`,
    ),
    primaryKey({
      name: 'artifact_links_identity_unique',
      columns: [
        table.workspaceId,
        table.artifactId,
        table.ownerKind,
        table.ownerId,
      ],
    }),
    foreignKey({
      name: 'artifact_links_artifact_fk',
      columns: [table.workspaceId, table.artifactId],
      foreignColumns: [artifacts.workspaceId, artifacts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'artifact_links_preview_run_fk',
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [previewRuns.workspaceId, previewRuns.id],
    }).onDelete('restrict'),
    index('artifact_links_owner_idx').on(
      table.workspaceId,
      table.ownerKind,
      table.ownerId,
      table.artifactId,
    ),
  ],
);
