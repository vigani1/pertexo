import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflowVersions } from '@pertexo/database/schema';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { WorkflowRef } from '../../shared/workflow-actor.types.js';
import { versionProjection } from '../workflows/representation/workflow-representations.repository.js';
import type { CompiledPublication } from './workflow-publication.types.js';

/** Versions with a matching checksum read per page, newest first. */
const RETAINED_VERSION_PAGE_SIZE = 16;

type VersionRow = Awaited<ReturnType<typeof readRetainedPage>>[number];

/**
 * The newest retained version with this checksum that `matches`, read in
 * newest-first pages so the full history is never held at once.
 */
export async function findRetainedVersion(
  client: PoolClient,
  workflow: WorkflowRef,
  checksum: string,
  matches: (row: VersionRow) => boolean,
): Promise<VersionRow | undefined> {
  let beforeVersion: number | undefined;
  for (;;) {
    const retained = await readRetainedPage(
      client,
      workflow,
      checksum,
      beforeVersion,
    );
    const match = retained.find(matches);
    if (match !== undefined || retained.length < RETAINED_VERSION_PAGE_SIZE)
      return match;
    beforeVersion = retained.at(-1)?.versionNumber;
  }
}

function readRetainedPage(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
  checksum: string,
  beforeVersion: number | undefined,
) {
  return drizzle(client)
    .select(versionProjection)
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.checksum, checksum),
        beforeVersion === undefined
          ? undefined
          : lt(workflowVersions.versionNumber, beforeVersion),
      ),
    )
    .orderBy(desc(workflowVersions.versionNumber))
    .limit(RETAINED_VERSION_PAGE_SIZE)
    .catch(rethrowQueryFailure);
}

/** Stores the publication as the workflow's next version number. */
export async function insertNextVersion(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
  publication: CompiledPublication,
  actorId: string,
): Promise<VersionRow | undefined> {
  const db = drizzle(client);
  const [row] = await db
    .insert(workflowVersions)
    .select(
      db
        .select({
          id: sql<string>`${publication.versionId}::uuid`.as('id'),
          workspaceId: sql<string>`${workspaceId}::uuid`.as('workspace_id'),
          workflowId: sql<string>`${workflowId}::uuid`.as('workflow_id'),
          versionNumber:
            sql<number>`coalesce(max(${workflowVersions.versionNumber}),0)+1`.as(
              'version_number',
            ),
          graphJson:
            sql<unknown>`${JSON.stringify(publication.graph)}::json`.as(
              'graph_json',
            ),
          checksum: sql<string>`${publication.checksum}::varchar`.as(
            'checksum',
          ),
          executableJson:
            sql<unknown>`${JSON.stringify(publication.executable.executableJson)}::json`.as(
              'executable_json',
            ),
          publishedBy: sql<string>`${actorId}::uuid`.as('published_by'),
          publishedAt: sql<Date>`clock_timestamp()`.as('published_at'),
        })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workspaceId, workspaceId),
            eq(workflowVersions.workflowId, workflowId),
          ),
        ),
    )
    .returning(versionProjection)
    .catch(rethrowQueryFailure);
  return row;
}
