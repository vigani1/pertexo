import { workflowPublicationRequests } from '@pertexo/database/schema';
import { sql } from 'drizzle-orm';
import { deletionRule } from '../../../shared/retention-deletion.js';

const reviewExpired = sql`coalesce(${workflowPublicationRequests.decidedAt},${workflowPublicationRequests.expiresAt})<=clock_timestamp()-interval '30 days'`;

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
