import type {
  ConnectionUsageRecord,
  ConnectionUsageDatabase,
} from './contract.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  connectionScope,
  connectionScopeSql,
} from '../../tenant-access/resources/connections/scope.js';
import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { connections } from '../../schema/connections.js';
import { workflowIntegrationUsage as usage } from '../../schema/authoring/integrations.js';
import {
  workflowVersions as version,
  workflows as workflow,
} from '../../schema/authoring/workflows.js';
import type { FolderScope } from '../../tenant-access/resources/contract.js';
import { requireConnectionReader } from '../authority.queries.js';
import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import { workflowScopeSql } from '../../tenant-access/resources/scope.queries.js';

import type { Pool } from 'pg';
import { z } from 'zod';

import { ConnectionNotFoundError } from '../contract.js';
import { uuidSchema } from '../admission.js';
import { withConnectionTransaction } from '../transactions.repository.js';

/** The projection index pages version identities before bounded metadata joins. */
export function connectionUsagePage(
  db: Pick<NodePgDatabase, 'select' | '$with' | 'with'>,
  input: Readonly<{
    workspaceId: string;
    connectionId: string;
    after?: string | undefined;
    limit: number;
    resources: FolderScope;
  }>,
) {
  const page = db.$with('page').as(
    db
      .select({
        workflowVersionId: usage.workflowVersionId,
        operationKeys: sql<
          string[]
        >`array_agg(distinct ${usage.operationKey} order by ${usage.operationKey})`.as(
          'operation_keys',
        ),
      })
      .from(usage)
      .innerJoin(
        version,
        and(
          eq(version.workspaceId, usage.workspaceId),
          eq(version.id, usage.workflowVersionId),
        ),
      )
      .where(
        and(
          eq(usage.workspaceId, input.workspaceId),
          eq(usage.connectionId, input.connectionId),
          workflowScopeSql(input.resources, sql`${version.workflowId}`),
          input.after === undefined
            ? undefined
            : gt(usage.workflowVersionId, input.after),
        ),
      )
      .groupBy(usage.workflowVersionId)
      .orderBy(usage.workflowVersionId)
      .limit(input.limit),
  );
  return db
    .with(page)
    .select({
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowLifecycleStatus: sql<
        ConnectionUsageRecord['workflowLifecycleStatus']
      >`${workflow.lifecycleStatus}`,
      workflowVersionId: version.id,
      versionNumber: version.versionNumber,
      isCurrentPublication: sql<boolean>`coalesce(${workflow.publishedVersionId}=${version.id},false)`,
      operationKeys: page.operationKeys,
    })
    .from(page)
    .innerJoin(
      version,
      and(
        eq(version.workspaceId, input.workspaceId),
        eq(version.id, page.workflowVersionId),
      ),
    )
    .innerJoin(
      workflow,
      and(
        eq(workflow.workspaceId, input.workspaceId),
        eq(workflow.id, version.workflowId),
      ),
    )
    .orderBy(page.workflowVersionId);
}

export function createConnectionUsagePersistence(
  pool: Pool,
): ConnectionUsageDatabase {
  return Object.freeze({
    listConnectionUsage: (input) => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const limit = z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(input.limit ?? 50);
      const after =
        input.after === undefined
          ? undefined
          : uuidSchema.parse(input.after.workflowVersionId);
      return withConnectionTransaction(pool, input.workspaceId, {
        actorId,
        operation: async (client, workspaceId) => {
          const role = await requireConnectionReader(
            client,
            workspaceId,
            actorId,
          );
          const resources = await readFolderScope(
            client,
            { workspaceId, actorId },
            role,
          );
          const db = drizzle(client);
          const found = await db
            .select({ id: connections.id })
            .from(connections)
            .where(
              and(
                eq(connections.workspaceId, workspaceId),
                eq(connections.id, connectionId),
                connectionScopeSql(
                  connectionScope(
                    { workspaceId, actorId },
                    role,
                    'connection:read',
                  ),
                  sql`${connections}`,
                ),
              ),
            )
            .catch(rethrowQueryFailure);
          if (found.length !== 1)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (after !== undefined) {
            const anchor = await db
              .select({ id: usage.workflowVersionId })
              .from(usage)
              .innerJoin(
                version,
                and(
                  eq(version.workspaceId, usage.workspaceId),
                  eq(version.id, usage.workflowVersionId),
                ),
              )
              .where(
                and(
                  eq(usage.workspaceId, workspaceId),
                  eq(usage.connectionId, connectionId),
                  eq(usage.workflowVersionId, after),
                  workflowScopeSql(resources, sql`${version.workflowId}`),
                ),
              )
              .limit(1)
              .catch(rethrowQueryFailure);
            if (anchor.length !== 1)
              throw new ConnectionNotFoundError(
                'Connection usage cursor is not visible',
              );
          }
          const result = await connectionUsagePage(db, {
            workspaceId,
            connectionId,
            after,
            limit: limit + 1,
            resources,
          });
          const items = Object.freeze(
            result.slice(0, limit).map((row) =>
              Object.freeze({
                ...row,
                operationKeys: Object.freeze(row.operationKeys),
              }),
            ),
          );
          const last = items.at(-1);
          return Object.freeze({
            items,
            ...(result.length > limit && last !== undefined
              ? {
                  nextCursor: Object.freeze({
                    workflowVersionId: last.workflowVersionId,
                  }),
                }
              : {}),
          });
        },
      });
    },
  });
}
