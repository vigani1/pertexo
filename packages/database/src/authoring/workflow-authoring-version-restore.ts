import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  workflowDraftRepresentationTag,
  type WorkflowDefinitionCatalogV1,
} from '@pertexo/workflow-model/graph';

import { generatePersistedId } from '../platform/persisted-id.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from './workflow-authoring-errors.js';
import type {
  RestoreWorkflowVersionInput,
  WorkflowAuthoringDatabase,
  WorkflowAuthoringTestHooks,
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from './workflow-authoring.js';
import {
  workflowRowSelection,
  workflowVersionRowSelection,
} from './workflow-authoring-rows.js';

type VersionRestoreStore = Pick<
  WorkflowAuthoringDatabase,
  'restoreWorkflowVersion'
>;

type SelectedCatalogs = Readonly<{
  definitionCatalog: WorkflowDefinitionCatalogV1;
  placementDefinitionCatalog: WorkflowDefinitionCatalogV1 | undefined;
}>;

export type WorkflowVersionRestoreContext = Readonly<{
  mapDraft(
    row: Record<string, unknown>,
    definitionCatalog: WorkflowDefinitionCatalogV1,
  ): WorkflowDraftRecord;
  mapVersion(row: Record<string, unknown>): WorkflowVersionRecord;
  mapWorkflow(row: Record<string, unknown>): WorkflowRecord;
  requireAuthor(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
  ): Promise<void>;
  requirePlaceable(
    previous: WorkflowDraftRecord['graphJson'],
    next: WorkflowDraftRecord['graphJson'],
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
const workflowDraftTagSchema = z
  .string()
  .regex(/^"draft-v1\.[A-Za-z0-9_-]{43}"$/u);

async function restoreWorkflowVersion(
  context: WorkflowVersionRestoreContext,
  input: RestoreWorkflowVersionInput,
): Promise<WorkflowDraftRecord> {
  const workspaceId = uuidSchema.parse(input.workspaceId);
  const workflowId = uuidSchema.parse(input.workflowId);
  const versionId = uuidSchema.parse(input.versionId);
  const actorId = uuidSchema.parse(input.actorId);
  const representationTag = workflowDraftTagSchema.parse(
    input.representationTag,
  );

  return context.transact(workspaceId, actorId, async (client) => {
    await context.requireAuthor(client, workspaceId, actorId);
    const { definitionCatalog, placementDefinitionCatalog } =
      await context.selectCatalogs(client);

    const workflowResult = await client.query<Record<string, unknown>>(
      `select ${workflowRowSelection} from app.workflows
       where workspace_id=$1 and id=$2 and lifecycle_status='active'
       for update`,
      [workspaceId, workflowId],
    );
    const workflowRow = workflowResult.rows[0];
    if (workflowRow === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    context.mapWorkflow(workflowRow);

    const draftResult = await client.query<Record<string, unknown>>(
      `select * from app.workflow_drafts
       where workspace_id=$1 and workflow_id=$2
       for update`,
      [workspaceId, workflowId],
    );
    const draftRow = draftResult.rows[0];
    if (draftRow === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const currentDraft = context.mapDraft(draftRow, definitionCatalog);
    const currentTag = workflowDraftRepresentationTag({
      workflowId,
      revision: currentDraft.revision,
      graph: currentDraft.graphJson,
      compatibilityFingerprint: currentDraft.compatibility.fingerprint,
    });
    if (currentTag !== representationTag)
      throw new WorkflowRevisionConflictError(
        currentDraft.revision,
        currentTag,
      );

    const sourceResult = await client.query<Record<string, unknown>>(
      `select ${workflowVersionRowSelection} from app.workflow_versions
       where workspace_id=$1 and workflow_id=$2 and id=$3`,
      [workspaceId, workflowId, versionId],
    );
    const sourceRow = sourceResult.rows[0];
    if (sourceRow === undefined)
      throw new WorkflowNotFoundError('Workflow version is not visible');
    const sourceVersion = context.mapVersion(sourceRow);
    await context.testHooks?.afterVersionRestoreStep?.('source');
    context.requirePlaceable(
      currentDraft.graphJson,
      sourceVersion.graphJson,
      placementDefinitionCatalog,
    );

    const updatedResult = await client.query<Record<string, unknown>>(
      `update app.workflow_drafts set graph_json=$1::jsonb,
         schema_version=$2,revision=revision+1,updated_by=$3,
         updated_at=transaction_timestamp()
       where workspace_id=$4 and workflow_id=$5 and revision=$6
         and exists (
           select 1 from app.workflows workflow
           where workflow.workspace_id=$4 and workflow.id=$5
             and workflow.lifecycle_status='active'
         )
       returning *`,
      [
        JSON.stringify(sourceVersion.graphJson),
        sourceVersion.schemaVersion,
        actorId,
        workspaceId,
        workflowId,
        currentDraft.revision,
      ],
    );
    const updatedRow = updatedResult.rows[0];
    if (updatedRow === undefined)
      throw new WorkflowRevisionConflictError(
        currentDraft.revision,
        currentTag,
      );
    const restoredDraft = context.mapDraft(updatedRow, definitionCatalog);
    await context.testHooks?.afterVersionRestoreStep?.('draft');

    await client.query(
      `insert into app.audit_events
         (id,workspace_id,actor_user_id,action,target_type,target_id,
          request_id,trace_id,metadata)
       values($1,$2,$3,'workflow.version_restored','workflow',$4,$5,$6,$7::jsonb)`,
      [
        generatePersistedId(),
        workspaceId,
        actorId,
        workflowId,
        input.requestId ?? null,
        input.traceId ?? null,
        JSON.stringify({
          previousRevision: currentDraft.revision,
          revision: restoredDraft.revision,
          sourceVersionId: sourceVersion.id,
        }),
      ],
    );
    await context.testHooks?.afterVersionRestoreStep?.('audit');
    return restoredDraft;
  });
}

export function createWorkflowVersionRestoreStore(
  context: WorkflowVersionRestoreContext,
): VersionRestoreStore {
  return Object.freeze({
    restoreWorkflowVersion: (input) => restoreWorkflowVersion(context, input),
  });
}
