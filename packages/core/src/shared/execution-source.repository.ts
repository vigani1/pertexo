import { sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import {
  workflowTestSnapshots,
  workflowVersions,
} from '@pertexo/database/schema';

/** Both sources are immutable; a test snapshot never enters publication queries. */
const sourceBuilder = new QueryBuilder();
export const EXECUTION_SOURCE_SQL = sourceBuilder
  .select({
    id: workflowVersions.id,
    workspace_id: workflowVersions.workspaceId,
    workflow_id: workflowVersions.workflowId,
    version_number: workflowVersions.versionNumber,
    checksum: workflowVersions.checksum,
    executable_json: workflowVersions.executableJson,
    test_dispositions: sql<
      typeof workflowTestSnapshots.$inferSelect.dispositions | null
    >`null::jsonb`.as('test_dispositions'),
    test_expires_at: sql<Date | null>`null::timestamptz`
      .mapWith(workflowTestSnapshots.expiresAt)
      .as('test_expires_at'),
  })
  .from(workflowVersions)
  .unionAll(
    sourceBuilder
      .select({
        id: workflowTestSnapshots.id,
        workspace_id: workflowTestSnapshots.workspaceId,
        workflow_id: workflowTestSnapshots.workflowId,
        version_number: workflowTestSnapshots.draftRevision,
        checksum: workflowTestSnapshots.checksum,
        executable_json: workflowTestSnapshots.executableJson,
        test_dispositions: workflowTestSnapshots.dispositions,
        test_expires_at: workflowTestSnapshots.expiresAt,
      })
      .from(workflowTestSnapshots),
  )
  .as('version');
