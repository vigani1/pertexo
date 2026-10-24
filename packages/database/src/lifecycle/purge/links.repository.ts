import { workflowFolders } from '../../schema/authoring/organization.js';
import { previewRuns } from '../../schema/runs/execution.js';
import {
  connectionSecretVersions,
  connections,
} from '../../schema/connections.js';
import {
  failureNotificationDestinationVersions,
  failureNotificationDestinations,
} from '../../schema/notifications.js';
import { and, eq, exists, inArray, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '../../platform/query-errors.js';

export async function purgeFolderLeaves(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client),
    child = alias(workflowFolders, 'child');
  const page = db.$with('page').as(
    db
      .select({ ctid: sql<string>`${workflowFolders}.ctid`.as('purge_ctid') })
      .from(workflowFolders)
      .where(
        and(
          eq(workflowFolders.workspaceId, workspaceId),
          notExists(
            db
              .select({ one: sql`1` })
              .from(child)
              .where(
                and(
                  eq(child.workspaceId, workflowFolders.workspaceId),
                  eq(child.parentId, workflowFolders.id),
                ),
              ),
          ),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .delete(workflowFolders)
      .where(
        inArray(
          sql<string>`${workflowFolders}.ctid`,
          db.select({ ctid: page.ctid }).from(page),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function purgePreviewLeaves(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client),
    child = alias(previewRuns, 'child');
  const page = db.$with('page').as(
    db
      .select({ ctid: sql<string>`${previewRuns}.ctid`.as('purge_ctid') })
      .from(previewRuns)
      .where(
        and(
          eq(previewRuns.workspaceId, workspaceId),
          notExists(
            db
              .select({ one: sql`1` })
              .from(child)
              .where(
                and(
                  eq(child.workspaceId, workspaceId),
                  eq(child.priorPreviewRunId, previewRuns.id),
                ),
              ),
          ),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .delete(previewRuns)
      .where(
        inArray(
          sql<string>`${previewRuns}.ctid`,
          db.select({ ctid: page.ctid }).from(page),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function purgeOldConnectionSecrets(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({
        ctid: sql<string>`${connectionSecretVersions}.ctid`.as('purge_ctid'),
      })
      .from(connectionSecretVersions)
      .innerJoin(
        connections,
        eq(connections.id, connectionSecretVersions.connectionId),
      )
      .where(
        and(
          eq(connectionSecretVersions.workspaceId, workspaceId),
          ne(connectionSecretVersions.id, connections.currentSecretVersionId),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .delete(connectionSecretVersions)
      .where(
        inArray(
          sql<string>`${connectionSecretVersions}.ctid`,
          db.select({ ctid: page.ctid }).from(page),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function purgeConnections(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({
        id: connections.id,
        currentSecretVersionId: connections.currentSecretVersionId,
      })
      .from(connections)
      .where(eq(connections.workspaceId, workspaceId))
      .limit(Math.max(1, Math.floor(pageSize / 2))),
  );
  const versions = db.$with('versions').as(
    db
      .delete(connectionSecretVersions)
      .where(
        exists(
          db
            .select({ one: sql`1` })
            .from(page)
            .where(
              eq(page.currentSecretVersionId, connectionSecretVersions.id),
            ),
        ),
      )
      .returning({ connectionId: connectionSecretVersions.connectionId }),
  );
  return (
    await db
      .with(page, versions)
      .delete(connections)
      .where(
        and(
          exists(
            db
              .select({ one: sql`1` })
              .from(page)
              .where(eq(page.id, connections.id)),
          ),
          exists(
            db
              .select({ one: sql`1` })
              .from(versions)
              .where(eq(versions.connectionId, connections.id)),
          ),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function purgeOldDestinationVersions(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({
        ctid: sql<string>`${failureNotificationDestinationVersions}.ctid`.as(
          'ctid',
        ),
      })
      .from(failureNotificationDestinationVersions)
      .innerJoin(
        failureNotificationDestinations,
        eq(
          failureNotificationDestinations.id,
          failureNotificationDestinationVersions.destinationId,
        ),
      )
      .where(
        and(
          eq(failureNotificationDestinationVersions.workspaceId, workspaceId),
          ne(
            failureNotificationDestinationVersions.version,
            failureNotificationDestinations.currentConfigVersion,
          ),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .delete(failureNotificationDestinationVersions)
      .where(
        inArray(
          sql<string>`${failureNotificationDestinationVersions}.ctid`,
          db.select({ ctid: page.ctid }).from(page),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
export async function purgeDestinations(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({
        id: failureNotificationDestinations.id,
        currentConfigVersion:
          failureNotificationDestinations.currentConfigVersion,
      })
      .from(failureNotificationDestinations)
      .where(eq(failureNotificationDestinations.workspaceId, workspaceId))
      .limit(Math.max(1, Math.floor(pageSize / 2))),
  );
  const versions = db.$with('versions').as(
    db
      .delete(failureNotificationDestinationVersions)
      .where(
        exists(
          db
            .select({ one: sql`1` })
            .from(page)
            .where(
              and(
                eq(
                  page.id,
                  failureNotificationDestinationVersions.destinationId,
                ),
                eq(
                  page.currentConfigVersion,
                  failureNotificationDestinationVersions.version,
                ),
              ),
            ),
        ),
      )
      .returning({
        destinationId: failureNotificationDestinationVersions.destinationId,
      }),
  );
  return (
    await db
      .with(page, versions)
      .delete(failureNotificationDestinations)
      .where(
        and(
          exists(
            db
              .select({ one: sql`1` })
              .from(page)
              .where(eq(page.id, failureNotificationDestinations.id)),
          ),
          exists(
            db
              .select({ one: sql`1` })
              .from(versions)
              .where(
                eq(versions.destinationId, failureNotificationDestinations.id),
              ),
          ),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
