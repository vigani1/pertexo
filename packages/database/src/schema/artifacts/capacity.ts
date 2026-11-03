import {
  type PgTableExtraConfigValue,
  bigint,
  check,
  integer,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

/** What a workspace may store before its capacity row exists or an operator changes it. */
export const DEFAULT_ARTIFACT_BYTE_LIMIT = 1_073_741_824;

export const workspaceArtifactCapacity = appSchema.table(
  'workspace_artifact_capacity',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    byteLimit: bigint('byte_limit', { mode: 'number' })
      .notNull()
      .default(sql.raw(String(DEFAULT_ARTIFACT_BYTE_LIMIT))),
    artifactCountLimit: integer('artifact_count_limit')
      .notNull()
      .default(sql`app.instance_artifact_count_limit()`),
    chargedBytes: bigint('charged_bytes', { mode: 'number' })
      .notNull()
      .default(sql`0`),
    chargedCount: integer('charged_count')
      .notNull()
      .default(sql`0`),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (): PgTableExtraConfigValue[] => [
    check(
      'workspace_artifact_capacity_byte_limit_valid',
      sql`(byte_limit >= 0)`,
    ),
    check(
      'workspace_artifact_capacity_charged_bytes_valid',
      sql`(charged_bytes >= 0)`,
    ),
    check(
      'workspace_artifact_capacity_charged_count_valid',
      sql`(charged_count >= 0)`,
    ),
    check(
      'workspace_artifact_capacity_count_limit_valid',
      sql`(artifact_count_limit >= 0)`,
    ),
  ],
);
