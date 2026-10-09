import { generatePersistedId } from '../platform/persisted-id.js';

import { z } from 'zod';
import {
  EMPTY_WORKFLOW_GRAPH,
  parseWorkflowGraphDraft,
} from '@pertexo/workflow-model';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';

import { claimCommand, completeCommand } from '../platform/idempotency.js';
import {
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
} from './workflow-authoring-contracts.js';
import type { WorkflowDraftRecord } from './workflow-authoring-records.js';
import type { WorkflowAuthoringWriteContext } from './workflow-authoring-context.js';

type DraftStore = Pick<
  WorkflowAuthoringDatabase,
  'createWorkflow' | 'saveDraft'
>;

const uuidSchema = z.uuid();
const createdResultSchema = z.object({ workflowId: uuidSchema }).strict();
const nameSchema = z.string().trim().min(1).max(128);
const workflowDraftTagSchema = z
  .string()
  .regex(/^"draft-v1\.[A-Za-z0-9_-]{43}"$/u);

async function createWorkflow(
  context: WorkflowAuthoringWriteContext,
  input: CreateWorkflowInput,
): Promise<CreateWorkflowResult> {
  return context.transact(input.workspaceId, input.actorId, async (client) => {
    const workflowId = uuidSchema.parse(input.id ?? generatePersistedId());
    const graph = parseWorkflowGraphDraft(input.emptyGraph);
    await context.requireAuthor(client, input.workspaceId, input.actorId);
    const { definitionCatalog, placementDefinitionCatalog } =
      await context.selectCatalogs(client);
    context.requirePlaceable(
      EMPTY_WORKFLOW_GRAPH,
      graph,
      placementDefinitionCatalog,
    );
    const name = nameSchema.parse(input.name);
    const command = {
      workspaceId: input.workspaceId,
      operation: 'workflow.create',
      scope: input.actorId,
      idempotencyKey: input.idempotencyKey,
    };
    const stored = await claimCommand(client, {
      ...command,
      request: { name, graph, requestedWorkflowId: input.id ?? null },
      resourceId: workflowId,
    });
    let createdId = workflowId;
    if (stored !== null)
      createdId = createdResultSchema.parse(stored).workflowId;
    else {
      await client.query(
        `insert into app.workflows
           (id, workspace_id, name, lifecycle_status, activation_status, created_by)
         values ($1, $2, $3, 'active', 'inactive', $4)`,
        [workflowId, input.workspaceId, name, input.actorId],
      );
      await client.query(
        `insert into app.workflow_drafts
           (workflow_id, workspace_id, revision, schema_version, graph_json, updated_by)
         values ($1, $2, 1, $3, $4::jsonb, $5)`,
        [
          workflowId,
          input.workspaceId,
          graph.schemaVersion,
          JSON.stringify(graph),
          input.actorId,
        ],
      );
      await client.query(
        `insert into app.audit_events
           (id, workspace_id, actor_user_id, action, target_type, target_id,
            request_id, trace_id, metadata)
         values ($1, $2, $3, 'workflow.created', 'workflow', $4, $5, $6,
                 '{"revision":1}'::jsonb)`,
        [
          generatePersistedId(),
          input.workspaceId,
          input.actorId,
          workflowId,
          input.requestId ?? null,
          input.traceId ?? null,
        ],
      );
      await completeCommand(client, command, { workflowId });
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
    if (created.rows[0] === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const row = createdWorkflowRowSchema.parse(created.rows[0]);
    return Object.freeze({
      workflowId: createdId,
      workflow: mapWorkflow(row.workflow),
      draft: mapDraft(row.draft, definitionCatalog),
    });
  });
}

async function saveDraft(
  context: WorkflowAuthoringWriteContext,
  input: SaveWorkflowDraftInput,
): Promise<WorkflowDraftRecord> {
  const representationTag = workflowDraftTagSchema.parse(
    input.representationTag,
  );
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
    const currentTag = draftRepresentationTag(workflowId, currentDraft);
    if (currentTag !== representationTag || currentDraft.revision !== expected)
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
    draftRepresentationTag(workflowId, draft),
  );
}

function draftRepresentationTag(
  workflowId: string,
  draft: WorkflowDraftRecord,
): string {
  return workflowDraftRepresentationTag({
    workflowId,
    revision: draft.revision,
    graph: draft.graphJson,
    compatibilityFingerprint: draft.compatibility.fingerprint,
  });
}

export function createWorkflowAuthoringDraftStore(
  context: WorkflowAuthoringWriteContext,
): DraftStore {
  return Object.freeze({
    createWorkflow: (input) => createWorkflow(context, input),
    saveDraft: (input) => saveDraft(context, input),
  });
}
