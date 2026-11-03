import {
  type PgTableExtraConfigValue,
  boolean,
  check,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

export const outboxFairDispatchCursor = appSchema.table(
  'outbox_fair_dispatch_cursor',
  {
    singleton: boolean().default(true).primaryKey().notNull(),
    lastWorkspaceId: uuid('last_workspace_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (): PgTableExtraConfigValue[] => [
    check('outbox_fair_dispatch_cursor_singleton_check', sql`singleton`),
  ],
);
