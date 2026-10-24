import {
  readConnectionScope,
  connectionScopeSql,
} from '../../tenant-access/resources/connections/scope.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import {
  workflows,
  workflowDrafts,
  workflowVersions,
} from '../../schema/authoring/workflows.js';
import { connections } from '../../schema/connections.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { authorizeWorkflowResource } from '../../tenant-access/resources/authority.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  parseWorkflowGraphDraft,
  type PortableConnectionBinding,
  type WorkflowGraph,
  type WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import type { ExportWorkflowInput } from '../workflows/contract.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflows/errors.js';
import {
  projectDraft,
  draftProjection,
} from '../workflows/representation/records.queries.js';
import type { AuthoringCatalogs } from '../workflows/catalogs.js';

/** Lock workflow before its selected source; select catalog only after source. */
export async function lockPortableSource(
  client: PoolClient,
  input: ExportWorkflowInput,
) {
  if (
    !(await authorizeWorkflowResource(client, input, {
      capability: 'workflow:read',
      locking: true,
    }))
  )
    throw new WorkflowNotFoundError('Workflow source is not visible');
  const db = drizzle(client);
  const workflow = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  if (workflow.length !== 1)
    throw new WorkflowNotFoundError('Workflow source is not visible');
  if (input.source.kind === 'draft') {
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
    if (row === undefined || row.graphJson === null)
      throw new WorkflowNotFoundError('Workflow source is not visible');
    return { kind: 'draft' as const, row };
  }
  // Immutable versions need only the workflow share lock to prevent purging.
  const [row] = await db
    .select({ graphJson: workflowVersions.graphJson })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, input.workspaceId),
        eq(workflowVersions.workflowId, input.workflowId),
        eq(workflowVersions.id, z.uuid().parse(input.source.versionId)),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined || row.graphJson === null)
    throw new WorkflowNotFoundError('Workflow source is not visible');
  return { kind: 'version' as const, row };
}

export function reviewedSourceGraph(
  input: ExportWorkflowInput,
  source: Awaited<ReturnType<typeof lockPortableSource>>,
  selection: AuthoringCatalogs,
): WorkflowGraph {
  if (source.kind === 'version')
    return parseWorkflowGraphDraft(source.row.graphJson);
  const draft = projectDraft(source.row, selection.definitionCatalog);
  const tag = workflowDraftRepresentationTag({
    workflowId: input.workflowId,
    revision: draft.revision,
    graph: draft.graphJson,
    compatibilityFingerprint: draft.compatibility.fingerprint,
  });
  if (tag !== input.representationTag)
    throw new WorkflowRevisionConflictError(draft.revision, tag);
  return draft.graphJson;
}

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
    ...new Set(
      bindings.map(({ connectionId }) => z.uuid().parse(connectionId)),
    ),
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
      row.providerKey !== slot.providerKey ||
      row.authType !== slot.authType;
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
