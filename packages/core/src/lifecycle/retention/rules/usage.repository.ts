import { usageEvents } from '@pertexo/database/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { RUN_SUMMARY_RETENTION_SQL } from '../../../runs/data-policy.js';
import { deletionRule } from '../../../shared/retention-deletion.js';

const skipsExpired = and(
  inArray(usageEvents.category, ['trigger.skipped', 'trigger.coordinated']),
  sql`${usageEvents.occurredAt}<=clock_timestamp()-${RUN_SUMMARY_RETENTION_SQL}`,
);

export const triggerSkips = deletionRule('trigger_skips', {
  table: usageEvents,
  keys: [usageEvents.id],
  condition: skipsExpired,
  orderBy: [usageEvents.occurredAt, usageEvents.id],
  recheck: skipsExpired,
});

/** One row per finished step test. It outlives its preview, which goes within a week. */
const previewUsageExpired = and(
  eq(usageEvents.category, 'preview_execution'),
  sql`${usageEvents.occurredAt}<=clock_timestamp()-${RUN_SUMMARY_RETENTION_SQL}`,
);

export const previewUsage = deletionRule('preview_usage', {
  table: usageEvents,
  keys: [usageEvents.id],
  condition: previewUsageExpired,
  orderBy: [usageEvents.occurredAt, usageEvents.id],
  recheck: previewUsageExpired,
});
