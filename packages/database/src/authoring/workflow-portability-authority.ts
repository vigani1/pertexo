import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  parseWorkflowGraphDraft,
  type PortableConnectionBinding,
  type WorkflowGraph,
  type WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import type { ExportWorkflowInput } from './workflow-authoring-contracts.js';
import type { WorkflowAuthoringWriteContext } from './workflow-authoring-context.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from './workflow-authoring-errors.js';
import { mapDraft } from './workflow-authoring-rows.js';

/** Lock workflow before its selected source; select catalog only after source. */
export async function lockPortableSource(
  client: PoolClient,
  input: ExportWorkflowInput,
) {
  const workflow = await client.query(
    "select id from app.workflows where workspace_id=$1 and id=$2 and lifecycle_status='active' for share",
    [input.workspaceId, input.workflowId],
  );
  if (workflow.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow source is not visible');
  const selected =
    input.source.kind === 'draft'
      ? await client.query<Record<string, unknown>>(
          'select * from app.workflow_drafts where workspace_id=$1 and workflow_id=$2 for share',
          [input.workspaceId, input.workflowId],
        )
      : // A version never changes; the workflow lock keeps it from being purged.
        await client.query<Record<string, unknown>>(
          'select graph_json from app.workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',
          [
            input.workspaceId,
            input.workflowId,
            z.uuid().parse(input.source.versionId),
          ],
        );
  const row = selected.rows[0];
  if (row === undefined || row.graph_json === null)
    throw new WorkflowNotFoundError('Workflow source is not visible');
  return row;
}

export function reviewedSourceGraph(
  input: ExportWorkflowInput,
  row: Record<string, unknown>,
  selection: Awaited<
    ReturnType<WorkflowAuthoringWriteContext['selectCatalogs']>
  >,
): WorkflowGraph {
  if (input.source.kind === 'version')
    return parseWorkflowGraphDraft(row.graph_json);
  const draft = mapDraft(row, selection.definitionCatalog);
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
  manifest: WorkflowPortableManifest,
  bindings: readonly PortableConnectionBinding[],
) {
  const ids = [
    ...new Set(
      bindings.map(({ connectionId }) => z.uuid().parse(connectionId)),
    ),
  ].sort();
  if (ids.length === 0) return [];
  const result = await client.query<{
    id: string;
    provider_key: string;
    auth_type: string;
    status: string;
  }>(
    'select id,provider_key,auth_type,status from app.connections where workspace_id=$1 and id=any($2::uuid[]) order by id for share',
    [workspaceId, ids],
  );
  const rows = new Map(result.rows.map((row) => [row.id, row]));
  const slots = new Map(
    manifest.connectionSlots.map((slot) => [
      `${slot.nodeId}\u0000${slot.slot}`,
      slot,
    ]),
  );
  return bindings.flatMap((binding) => {
    const row = rows.get(binding.connectionId);
    const slot = slots.get(`${binding.nodeId}\u0000${binding.slot}`);
    if (
      row === undefined ||
      slot === undefined ||
      row.status !== 'active' ||
      row.provider_key !== slot.providerKey ||
      row.auth_type !== slot.authType
    )
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
