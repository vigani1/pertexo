import { workflowPresenceLeases } from '@pertexo/database/schema';
import { lte, sql } from 'drizzle-orm';
import { deletionRule } from '../../../shared/retention-deletion.js';

const presenceExpired = lte(
  workflowPresenceLeases.expiresAt,
  sql`clock_timestamp()`,
);

export const presence = deletionRule('workflow_presence_leases', {
  table: workflowPresenceLeases,
  keys: [
    workflowPresenceLeases.workspaceId,
    workflowPresenceLeases.workflowId,
    workflowPresenceLeases.userId,
    workflowPresenceLeases.tabId,
  ],
  condition: presenceExpired,
  orderBy: [workflowPresenceLeases.expiresAt],
  recheck: presenceExpired,
});
