import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  parseWorkflowGraphDraft,
  type WorkflowGraph,
} from '@pertexo/workflow-model/graph';
import type {
  PortableConnectionBinding,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model/portability-contract';
import type { ExportWorkflowInput } from './workflow-authoring-contracts.js';
import type { WorkflowAuthoringWriteContext } from './workflow-authoring-context.js';
import { rolesForCapability } from '../tenant-access/workspace-policy.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  WorkflowDraftOperationUnavailableError,
} from './workflow-authoring-errors.js';
import { mapDraft, draftRepresentationTag } from './workflow-authoring-rows.js';

/** Never rely on a joined SELECT's planner to choose the authority lock order. */
export async function requirePortabilityAuthority(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  write: boolean,
): Promise<void> {
  const workspace = await client.query<{ status: string }>(
    'select app.lock_workspace_run_admission($1) status',
    [workspaceId],
  );
  if (workspace.rows[0]?.status !== 'active')
    throw new WorkflowNotFoundError('Workflow workspace is not visible');
  const actor = await client.query(
    "select id from app.users where id=$1 and status='active' for share",
    [actorId],
  );
  if (actor.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow actor is not visible');
  const membership = await client.query(
    `select user_id from app.workspace_memberships where workspace_id=$1 and user_id=$2
     and status='active' and role=any($3::text[]) for share`,
    [
      workspaceId,
      actorId,
      [...rolesForCapability(write ? 'workflow:create' : 'workflow:read')],
    ],
  );
  if (membership.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow workspace is not visible');
}

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
      : await client.query<Record<string, unknown>>(
          'select app.lock_workflow_portable_version($1,$2,$3,$4) graph_json',
          [
            input.workspaceId,
            input.workflowId,
            z.uuid().parse(input.source.versionId),
            input.actorId,
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
  const tag = draftRepresentationTag(input.workflowId, draft);
  if (tag !== input.representationTag)
    throw new WorkflowRevisionConflictError(draft.revision, tag);
  if (draft.schemaVersion === 2)
    throw new WorkflowDraftOperationUnavailableError();
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
