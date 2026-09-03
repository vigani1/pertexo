import { generatePersistedId } from './persisted-id.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  EMPTY_WORKFLOW_GRAPH_V1,
  parseWorkflowGraphDraft,
  workflowDraftRepresentationTag,
  type WorkflowDefinitionCatalogV1,
  type WorkflowGraph,
} from '@pertexo/workflow-model/graph';

import { canonicalOutboxPayloadChecksum } from './outbox.js';
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from './workflow-authoring-errors.js';
import {
  createdWorkflowRowSchema,
  mapDraft,
  mapWorkflow,
} from './workflow-authoring-rows.js';
import type {
  CreateWorkflowInput,
  CreateWorkflowResult,
  SaveWorkflowDraftInput,
  WorkflowAuthoringDatabase,
  WorkflowAuthoringTestHooks,
  WorkflowDraftRecord,
} from './workflow-authoring.js';

type DraftStore = Pick<
  WorkflowAuthoringDatabase,
  'createWorkflow' | 'saveDraft'
>;
type SelectedCatalogs = Readonly<{
  definitionCatalog: WorkflowDefinitionCatalogV1;
  placementDefinitionCatalog: WorkflowDefinitionCatalogV1 | undefined;
}>;

export type WorkflowAuthoringDraftContext = Readonly<{
  keyDigest(key: string): string;
  requireAuthor(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
  ): Promise<void>;
  requirePlaceable(
    previous: WorkflowGraph,
    next: WorkflowGraph,
    placementCatalog: WorkflowDefinitionCatalogV1 | undefined,
  ): void;
  selectCatalogs(client: Pick<PoolClient, 'query'>): Promise<SelectedCatalogs>;
  testHooks?: WorkflowAuthoringTestHooks;
  transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
}>;

const uuidSchema = z.uuid();
const nameSchema = z.string().trim().min(1).max(128);

async function createWorkflow(
  context: WorkflowAuthoringDraftContext,
  input: CreateWorkflowInput,
): Promise<CreateWorkflowResult> {
  return context.transact(input.workspaceId, input.actorId, async (client) => {
    const workflowId = uuidSchema.parse(input.id ?? generatePersistedId());
    const graph = parseWorkflowGraphDraft(input.emptyGraph);
    await context.requireAuthor(client, input.workspaceId, input.actorId);
    const { definitionCatalog, placementDefinitionCatalog } =
      await context.selectCatalogs(client);
    context.requirePlaceable(
      EMPTY_WORKFLOW_GRAPH_V1,
      graph,
      placementDefinitionCatalog,
    );
    const requestHash = canonicalOutboxPayloadChecksum({
      actorId: input.actorId,
      graph,
      name: nameSchema.parse(input.name),
      requestedWorkflowId: input.id ?? null,
      schemaVersion: graph.schemaVersion,
      workspaceId: input.workspaceId,
    });
    let createdId: string;
    try {
      const creation = await client.query<{ workflow_id: string }>(
        `select app.create_workflow_with_draft(
           $1, $2, $3::varchar, $4, $5, $6::jsonb, $7::char(64),
           $8::char(64), $9::varchar, $10::varchar
         ) as workflow_id`,
        [
          workflowId,
          input.workspaceId,
          nameSchema.parse(input.name),
          input.actorId,
          graph.schemaVersion,
          JSON.stringify(graph),
          context.keyDigest(input.idempotencyKey),
          requestHash,
          input.requestId ?? null,
          input.traceId ?? null,
        ],
      );
      createdId = uuidSchema.parse(creation.rows[0]?.workflow_id);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error as Error & { code?: string }).code === '23505'
      )
        throw new WorkflowIdempotencyConflictError(
          'Workflow create idempotency key request mismatch',
        );
      throw error;
    }
    const created = await client.query<Record<string, unknown>>(
      `select row_to_json(workflow.*) as workflow,
              row_to_json(draft.*) as draft
       from app.workflows workflow
       join app.workflow_drafts draft
         on draft.workspace_id = workflow.workspace_id
        and draft.workflow_id = workflow.id
       where workflow.workspace_id = $1 and workflow.id = $2`,
      [input.workspaceId, createdId],
    );
    const row = createdWorkflowRowSchema.parse(created.rows[0]);
    return Object.freeze({
      workflowId: createdId,
      workflow: mapWorkflow(row.workflow),
      draft: mapDraft(row.draft, definitionCatalog),
    });
  });
}

async function saveDraft(
  context: WorkflowAuthoringDraftContext,
  input: SaveWorkflowDraftInput,
): Promise<WorkflowDraftRecord> {
  return context.transact(input.workspaceId, input.actorId, async (client) => {
    await context.requireAuthor(client, input.workspaceId, input.actorId);
    const { definitionCatalog, placementDefinitionCatalog } =
      await context.selectCatalogs(client);
    const graph = parseWorkflowGraphDraft(input.graphJson);
    const expected = z.number().int().positive().parse(input.expectedRevision);
    const workflowId = uuidSchema.parse(input.workflowId);
    const current = await client.query<Record<string, unknown>>(
      `select draft.* from app.workflow_drafts draft
       join app.workflows workflow
         on workflow.workspace_id = draft.workspace_id
        and workflow.id = draft.workflow_id
       where draft.workspace_id = $1 and draft.workflow_id = $2
         and workflow.lifecycle_status = 'active'`,
      [input.workspaceId, workflowId],
    );
    const currentRow = current.rows[0];
    if (currentRow === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const currentDraft = mapDraft(currentRow, definitionCatalog);
    if (currentDraft.revision !== expected)
      throwRevisionConflict(workflowId, currentDraft);
    context.requirePlaceable(
      currentDraft.graphJson,
      graph,
      placementDefinitionCatalog,
    );
    const result = await client.query<Record<string, unknown>>(
      `update app.workflow_drafts set graph_json = $1::jsonb, schema_version = $2,
       revision = revision + 1, updated_by = $3, updated_at = transaction_timestamp()
       where workspace_id = $4 and workflow_id = $5 and revision = $6
         and exists (
           select 1 from app.workflows workflow
           where workflow.workspace_id = $4 and workflow.id = $5
             and workflow.lifecycle_status = 'active'
         )
       returning *`,
      [
        JSON.stringify(graph),
        graph.schemaVersion,
        input.actorId,
        input.workspaceId,
        workflowId,
        expected,
      ],
    );
    if (result.rows[0] === undefined) {
      const latest = await client.query<Record<string, unknown>>(
        `select draft.* from app.workflow_drafts draft
         join app.workflows workflow
           on workflow.workspace_id = draft.workspace_id
          and workflow.id = draft.workflow_id
         where draft.workspace_id = $1 and draft.workflow_id = $2
           and workflow.lifecycle_status = 'active'`,
        [input.workspaceId, workflowId],
      );
      const latestRow = latest.rows[0];
      if (latestRow === undefined)
        throw new WorkflowNotFoundError('Workflow is not visible');
      throwRevisionConflict(workflowId, mapDraft(latestRow, definitionCatalog));
    }
    const saved = mapDraft(result.rows[0], definitionCatalog);
    await context.testHooks?.afterSaveCas?.();
    await client.query(
      `insert into app.audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, request_id, trace_id, metadata)
       values ($1, $2, $3, 'workflow.draft_saved', 'workflow', $4, $5, $6, $7::jsonb)`,
      [
        generatePersistedId(),
        input.workspaceId,
        input.actorId,
        input.workflowId,
        input.requestId ?? null,
        input.traceId ?? null,
        JSON.stringify({
          previousRevision: expected,
          revision: saved.revision,
        }),
      ],
    );
    return saved;
  });
}

function throwRevisionConflict(
  workflowId: string,
  draft: WorkflowDraftRecord,
): never {
  throw new WorkflowRevisionConflictError(
    draft.revision,
    workflowDraftRepresentationTag({
      workflowId,
      revision: draft.revision,
      graph: draft.graphJson,
      compatibilityFingerprint: draft.compatibility.fingerprint,
    }),
  );
}

export function createWorkflowAuthoringDraftStore(
  context: WorkflowAuthoringDraftContext,
): DraftStore {
  return Object.freeze({
    createWorkflow: (input) => createWorkflow(context, input),
    saveDraft: (input) => saveDraft(context, input),
  });
}
