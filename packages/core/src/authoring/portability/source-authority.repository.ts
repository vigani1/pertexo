import {
  type PortableConnectionBinding,
  type WorkflowPortableManifest,
  connectionFitsSlot,
} from '@pertexo/workflow-model';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import { alias } from 'drizzle-orm/pg-core';

import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import {
  workflowDrafts,
  workflows,
  workflowVersions,
  connections,
} from '@pertexo/database/schema';

import {
  connectionScopeSql,
  readConnectionScope,
} from '../../shared/resources/connection-scope.repository.js';

import type { ExportWorkflowInput } from '../workflows/workflow-commands.types.js';

import { draftProjection } from '../workflows/representation/workflow-representations.repository.js';

/** Locks non-key health/status changes too; never fetch credential bytes. */
export async function inspectPortableConnections(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    manifest,
    bindings,
  }: Readonly<{
    actorId: string;
    manifest: WorkflowPortableManifest;
    bindings: readonly PortableConnectionBinding[];
  }>,
) {
  const ids = [
    ...new Set(bindings.map(({ connectionId }) => connectionId)),
  ].sort();
  if (ids.length === 0) return [];
  const connection = alias(connections, 'connection');
  const permitted = connectionScopeSql(
    await readConnectionScope(
      client,
      { workspaceId, actorId },
      'connection:use',
    ),
    connection,
  );
  const result = await drizzle(client)
    .select({
      id: connection.id,
      providerKey: connection.providerKey,
      authType: connection.authType,
      status: connection.status,
    })
    .from(connection)
    .where(
      and(
        eq(connection.workspaceId, workspaceId),
        inArray(connection.id, ids),
        permitted,
      ),
    )
    .orderBy(asc(connection.id))
    .for('share')
    .catch(rethrowQueryFailure);
  const rows = new Map(result.map((row) => [row.id, row]));
  const slots = new Map(
    manifest.connectionSlots.map((slot) => [
      `${slot.nodeId}\u0000${slot.slot}`,
      slot,
    ]),
  );
  return bindings.flatMap((binding) => {
    const row = rows.get(binding.connectionId);
    const slot = slots.get(`${binding.nodeId}\u0000${binding.slot}`);
    const connectionUnavailable =
      row === undefined ||
      slot === undefined ||
      row.status !== 'active' ||
      !connectionFitsSlot(row, slot);
    if (connectionUnavailable)
      return [
        {
          code: 'connection_unavailable',
          path: '$.bindings',
          message:
            'A selected destination connection is not available for this slot.',
        },
      ];
    return [];
  });
}

export async function shareLockWorkflow(
  client: PoolClient,
  input: ExportWorkflowInput,
): Promise<boolean> {
  const db = drizzle(client);
  const workflow = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return workflow.length === 1;
}

export async function shareLockDraft(
  client: PoolClient,
  input: ExportWorkflowInput,
) {
  const db = drizzle(client);
  const [row] = await db
    .select(draftProjection)
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, input.workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return row;
}

export async function readVersionGraph(
  client: PoolClient,
  input: ExportWorkflowInput,
  versionId: string,
) {
  const db = drizzle(client);
  const [row] = await db
    .select({ graphJson: workflowVersions.graphJson })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, input.workspaceId),
        eq(workflowVersions.workflowId, input.workflowId),
        eq(workflowVersions.id, versionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}
