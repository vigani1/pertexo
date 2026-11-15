import { workflowPublicationRequests } from '@pertexo/database/schema';
import { sql } from 'drizzle-orm';
import { deletionRule } from '../../../shared/retention-deletion.repository.js';
import { DAY_INTERVAL } from '../../../shared/sql-intervals.repository.js';

/** How long a decided or expired publication review is kept. */
const DECIDED_REVIEW_RETENTION_DAYS = 30;
const reviewExpired = sql`coalesce(${workflowPublicationRequests.decidedAt},${workflowPublicationRequests.expiresAt})<=clock_timestamp()-${DECIDED_REVIEW_RETENTION_DAYS}*${DAY_INTERVAL}`;

export const publicationRequests = deletionRule('publication_requests', {
  table: workflowPublicationRequests,
  keys: [
    workflowPublicationRequests.workspaceId,
    workflowPublicationRequests.id,
  ],
  condition: reviewExpired,
  orderBy: [
    sql`coalesce(${workflowPublicationRequests.decidedAt},${workflowPublicationRequests.expiresAt})`,
    workflowPublicationRequests.id,
  ],
  recheck: reviewExpired,
});
