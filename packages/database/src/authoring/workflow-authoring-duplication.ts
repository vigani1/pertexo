import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  EMPTY_WORKFLOW_GRAPH_V1,
  parseWorkflowGraphDraft,
  workflowDraftRepresentationTag,
  type WorkflowGraph,
  type WorkflowDefinitionCatalogV1,
} from '@pertexo/workflow-model/graph';

import { generatePersistedId } from '../platform/persisted-id.js';
import { canonicalApplicationPayloadChecksum } from '../execution/transport/outbox.js';
import type {
  DuplicateWorkflowInput,
  WorkflowAuthoringDatabase,
} from './workflow-authoring-contracts.js';
import type { WorkflowAuthoringWriteContext } from './workflow-authoring-context.js';
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from './workflow-authoring-errors.js';
import { mapDraft } from './workflow-authoring-rows.js';

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

/** Lock one durable source-scoped claim; mutable graph contents are not request identity. */
async function claimDuplicate(
  client: PoolClient,
  context: WorkflowAuthoringWriteContext,
  input: DuplicateWorkflowInput,
  destinationId: string,
) {
  const digest = context.keyDigest(input.idempotencyKey);
  const scope = `${input.actorId}:${input.workflowId}`;
  const requestHash = canonicalApplicationPayloadChecksum(
    {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      workflowId: input.workflowId,
      name: input.name,
      source: input.source,
      representationTag:
        input.source.kind === 'draft' ? input.representationTag : null,
    },
    4_096,
  );
  await client.query(
    `insert into app.idempotency_records
       (id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref)
     values($1,$2,'workflow.duplicate',$3,$4,$5,'in_progress',$6,'{}'::jsonb)
     on conflict(workspace_id,operation,scope,key_hash) do nothing`,
    [
      generatePersistedId(),
      input.workspaceId,
      scope,
      digest,
      requestHash,
      destinationId,
    ],
  );
  const result = await client.query<{
    request_hash: string;
    status: string;
    result_ref: unknown;
    resource_id: string;
  }>(
    `select request_hash,status,result_ref,resource_id from app.idempotency_records
     where workspace_id=$1 and operation='workflow.duplicate' and scope=$2 and key_hash=$3 for update`,
    [input.workspaceId, scope, digest],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new Error('Workflow duplication claim is unavailable');
  if (row.request_hash !== requestHash)
    throw new WorkflowIdempotencyConflictError(
      'Idempotency key request mismatch',
    );
  const replay =
    row.status === 'completed' ? resultSchema.parse(row.result_ref) : null;
  if (replay !== null && replay.workflowId !== row.resource_id)
    throw new Error('Workflow duplication receipt identity is inconsistent');
  return { digest, scope, requestHash, replay };
}

async function selectedGraph(
  client: PoolClient,
  input: DuplicateWorkflowInput,
  catalog: WorkflowDefinitionCatalogV1,
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
          const claim = await claimDuplicate(
            client,
            context,
            input,
            destinationId,
          );
          await context.testHooks?.afterDuplicateStep?.('claim');
          if (claim.replay !== null) {
            const destination = await client.query(
              'select id from app.workflows where workspace_id=$1 and id=$2 for share',
              [input.workspaceId, claim.replay.workflowId],
            );
            if (destination.rowCount !== 1)
              throw new WorkflowNotFoundError(
                'Workflow destination is not visible',
              );
            return Object.freeze(claim.replay);
          }
          if (sourceRow.lifecycle_status !== 'active')
            throw new WorkflowNotFoundError('Workflow source is not visible');
          const { definitionCatalog, placementDefinitionCatalog } =
            await context.selectCatalogs(client);
          const graph = await selectedGraph(client, input, definitionCatalog);
          context.requirePlaceable(
            EMPTY_WORKFLOW_GRAPH_V1,
            graph,
            placementDefinitionCatalog ?? definitionCatalog,
          );
          await requireOwnedConnections(client, input.workspaceId, graph);
          await context.testHooks?.afterDuplicateStep?.('source');
          await client.query(
            'select app.create_workflow_duplicate_draft($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)',
            [
              destinationId,
              input.workspaceId,
              input.workflowId,
              input.actorId,
              input.name,
              graph.schemaVersion,
              JSON.stringify(graph),
              claim.digest,
              claim.requestHash,
              input.source.kind,
              input.source.kind === 'version' ? input.source.versionId : null,
            ],
          );
          await context.testHooks?.afterDuplicateStep?.('workflow');
          await context.testHooks?.afterDuplicateStep?.('draft');
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
          await context.testHooks?.afterDuplicateStep?.('audit');
          const result = Object.freeze({ workflowId: destinationId });
          const completed = await client.query(
            `update app.idempotency_records set status='completed',result_ref=$1::jsonb,updated_at=transaction_timestamp()
         where workspace_id=$2 and operation='workflow.duplicate' and scope=$3 and key_hash=$4 and status='in_progress'`,
            [
              JSON.stringify(result),
              input.workspaceId,
              claim.scope,
              claim.digest,
            ],
          );
          if (completed.rowCount !== 1)
            throw new Error('Workflow duplication completion is unavailable');
          await context.testHooks?.afterDuplicateStep?.('idempotency');
          return result;
        },
        input.signal,
      );
    },
  };
}
