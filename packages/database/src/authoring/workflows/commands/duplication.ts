import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  EMPTY_WORKFLOW_GRAPH,
  parseWorkflowGraphDraft,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  type WorkflowDefinitionCatalog,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';

import { generatePersistedId } from '../../../platform/persisted-id.js';
import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency.js';
import type {
  DuplicateWorkflowInput,
  WorkflowAuthoringDatabase,
} from '../contracts.js';
import type { WorkflowAuthoringWriteContext } from '../context.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../errors.js';
import { mapDraft } from '../rows.js';

const uuid = z.uuid();
const inputSchema = z
  .object({
    workspaceId: uuid,
    workflowId: uuid,
    actorId: uuid,
    name: z.string().trim().min(1).max(128),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('draft') }).strict(),
      z.object({ kind: z.literal('version'), versionId: uuid }).strict(),
    ]),
    representationTag: z
      .string()
      .regex(/^"draft-v1\.[A-Za-z0-9_-]{43}"$/u)
      .optional(),
    idempotencyKey: z.string(),
    requestId: z.string().optional(),
    traceId: z.string().optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.source.kind !== 'draft' || input.representationTag !== undefined,
  );
const resultSchema = z.object({ workflowId: uuid }).strict();

async function selectedGraph(
  client: PoolClient,
  input: DuplicateWorkflowInput,
  catalog: WorkflowDefinitionCatalog,
): Promise<WorkflowGraph> {
  if (input.source.kind === 'version') {
    const result = await client.query<{ graph_json: unknown }>(
      `select graph_json from app.workflow_versions
       where workspace_id=$1 and workflow_id=$2 and id=$3`,
      [input.workspaceId, input.workflowId, input.source.versionId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new WorkflowNotFoundError('Workflow source is not visible');
    return parseWorkflowGraphDraft(row.graph_json);
  }
  const result = await client.query<Record<string, unknown>>(
    `select * from app.workflow_drafts where workspace_id=$1 and workflow_id=$2 for update`,
    [input.workspaceId, input.workflowId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow source is not visible');
  const draft = mapDraft(row, catalog);
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

/** Check every nested reference, not only known provider slots; never load secret bytes. */
async function requireOwnedConnections(
  client: PoolClient,
  workspaceId: string,
  graph: WorkflowGraph,
): Promise<void> {
  const ids = new Set<string>();
  const pending: WorkflowGraph[] = [graph];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const node of current.nodes) {
      for (const reference of Object.values(node.connectionRefs)) {
        const id = uuid.safeParse(reference);
        if (!id.success)
          throw new WorkflowNotFoundError('Workflow connection is not visible');
        ids.add(id.data);
      }
      if (node.structured !== undefined) pending.push(node.structured.body);
    }
  }
  if (ids.size === 0) return;
  const connections = await client.query(
    `select id from app.connections where workspace_id=$1 and id=any($2::uuid[])
     order by id for key share`,
    [workspaceId, [...ids].sort()],
  );
  if (connections.rowCount !== ids.size)
    throw new WorkflowNotFoundError('Workflow connection is not visible');
}

export function createWorkflowDuplicationStore(
  context: WorkflowAuthoringWriteContext,
): Pick<WorkflowAuthoringDatabase, 'duplicateWorkflow'> {
  return {
    duplicateWorkflow: async (rawInput) => {
      const parsed = inputSchema.parse(rawInput);
      const input: DuplicateWorkflowInput = { ...rawInput, name: parsed.name };
      return context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await context.requireAuthor(client, input.workspaceId, input.actorId);
          // Workflow precedes draft, consistent with restore/publication/lifecycle.
          const source = await client.query<{ lifecycle_status: string }>(
            `select lifecycle_status from app.workflows where workspace_id=$1 and id=$2 for update`,
            [input.workspaceId, input.workflowId],
          );
          const sourceRow = source.rows[0];
          if (sourceRow === undefined)
            throw new WorkflowNotFoundError('Workflow source is not visible');
          const destinationId = generatePersistedId();
          // The graph is not part of the request: a retry duplicates the same
          // reviewed source, or replays the first result.
          const command = {
            workspaceId: input.workspaceId,
            operation: 'workflow.duplicate',
            scope: `${input.actorId}:${input.workflowId}`,
            idempotencyKey: input.idempotencyKey,
          };
          const stored = await claimCommand(client, {
            ...command,
            request: {
              name: input.name,
              source: input.source,
              representationTag:
                input.source.kind === 'draft' ? input.representationTag : null,
            },
            resourceId: destinationId,
          });
          if (stored !== null) {
            const replay = resultSchema.parse(stored);
            const destination = await client.query(
              'select id from app.workflows where workspace_id=$1 and id=$2 for share',
              [input.workspaceId, replay.workflowId],
            );
            if (destination.rowCount !== 1)
              throw new WorkflowNotFoundError(
                'Workflow destination is not visible',
              );
            return Object.freeze(replay);
          }
          if (sourceRow.lifecycle_status !== 'active')
            throw new WorkflowNotFoundError('Workflow source is not visible');
          const { definitionCatalog, placementDefinitionCatalog } =
            await context.selectCatalogs(client);
          const graph = await selectedGraph(client, input, definitionCatalog);
          context.requirePlaceable(
            EMPTY_WORKFLOW_GRAPH,
            graph,
            placementDefinitionCatalog ?? definitionCatalog,
          );
          await requireOwnedConnections(client, input.workspaceId, graph);
          await client.query(
            `insert into app.workflows
               (id, workspace_id, name, lifecycle_status, activation_status, created_by)
             values ($1, $2, $3, 'active', 'inactive', $4)`,
            [destinationId, input.workspaceId, input.name, input.actorId],
          );
          await client.query(
            `insert into app.workflow_drafts
               (workflow_id, workspace_id, revision, schema_version, graph_json, updated_by)
             values ($1, $2, 1, $3, $4::jsonb, $5)`,
            [
              destinationId,
              input.workspaceId,
              graph.schemaVersion,
              JSON.stringify(graph),
              input.actorId,
            ],
          );
          // A copy keeps its source's template origin, marked inherited.
          await client.query(
            `insert into app.workflow_template_origins (workspace_id, workflow_id, origin)
             select workspace_id, $2, origin || '{"derivation":"inherited"}'::jsonb
             from app.workflow_template_origins
             where workspace_id = $1 and workflow_id = $3`,
            [input.workspaceId, destinationId, input.workflowId],
          );
          await client.query(
            `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
         values($1,$2,$3,'workflow.duplicated','workflow',$4,$5,$6,$7::jsonb)`,
            [
              generatePersistedId(),
              input.workspaceId,
              input.actorId,
              destinationId,
              input.requestId ?? null,
              input.traceId ?? null,
              JSON.stringify({
                sourceWorkflowId: input.workflowId,
                source: input.source,
                revision: 1,
              }),
            ],
          );
          const result = Object.freeze({ workflowId: destinationId });
          await completeCommand(client, command, result);
          return result;
        },
        input.signal,
      );
    },
  };
}
