import {
  bigint,
  char,
  foreignKey,
  index,
  primaryKey,
  timestamp,
  varchar,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';
import { workspaces } from './foundation.js';

/**
 * No longer written. Reapers in areas not yet ported still check it; it goes
 * when they move to TypeScript.
 */
export const workspaceLegalHolds = appSchema.table(
  'workspace_legal_holds',
  {
    workspaceId: uuid('workspace_id').notNull(),
    holdId: uuid('hold_id').notNull(),
    placedSequence: bigint('placed_sequence', { mode: 'number' }).notNull(),
    placedRecordHash: char('placed_record_hash', { length: 64 }).notNull(),
    legalAuthority: varchar('legal_authority', { length: 256 }).notNull(),
    placementReason: varchar('placement_reason', { length: 512 }).notNull(),
    placedBy: varchar('placed_by', { length: 128 }).notNull(),
    placedAt: timestamp('placed_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    releasedSequence: bigint('released_sequence', { mode: 'number' }),
    releasedRecordHash: char('released_record_hash', { length: 64 }),
    releaseAuthority: varchar('release_authority', { length: 256 }),
    releaseReason: varchar('release_reason', { length: 512 }),
    releasedBy: varchar('released_by', { length: 128 }),
    releasedAt: timestamp('released_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.holdId] }),
    index('workspace_legal_holds_active_idx')
      .on(table.workspaceId, table.holdId)
      .where(sql`${table.releasedSequence} is null`),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: 'workspace_legal_holds_workspace_fk',
    }),
  ],
);
