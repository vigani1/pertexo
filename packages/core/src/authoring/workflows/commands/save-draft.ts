import {
  appendAuditFact,
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import { and, eq, exists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../../artifacts/references/locks.repository.js';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  workflowOrganizationState,
  workflowDrafts,
  workflows,
} from '@pertexo/database/schema';
import { requireWorkflowCallTargets } from '../../../tenant-access/resources/bindings.queries.js';
import { requireConnectionBindings } from '../../../tenant-access/resources/connections/bindings.queries.js';
import { readFolderScope } from '../../../shared/facts.queries.js';
import { pruneStepSamples } from '../../step-samples/records.repository.js';

import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import { z } from 'zod';

import type { WorkflowAuthoringWriteContext } from '../context.js';
import type {
  CreateWorkflowInput,
  CreateWorkflowResult,
  SaveWorkflowDraftInput,
  WorkflowAuthoringStore,
} from '../contract.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../errors.js';
import type { WorkflowDraftRecord } from '../representation/contract.js';
import {
  draftProjection,
  projectDraft,
  workflowProjection,
} from '../representation/records.queries.js';

type DraftStore = Pick<WorkflowAuthoringStore, 'createWorkflow' | 'saveDraft'>;

const uuidSchema = z.uuid();
const createdResultSchema = z.object({ workflowId: uuidSchema }).strict();

async function createWorkflow(
  context: WorkflowAuthoringWriteContext,
  input: CreateWorkflowInput,
): Promise<CreateWorkflowResult> {
  return context.transact(input.workspaceId, input.actorId, async (client) => {
    const workflowId = input.id ?? generatePersistedId();
    const graph = input.emptyGraph;
    await context.requireAuthor(client, input.workspaceId, {
      actorId: input.actorId,
    });
    const { definitionCatalog, placementDefinitionCatalog } = context.catalogs;
    context.requirePlaceable(
      EMPTY_WORKFLOW_GRAPH,
      graph,
      placementDefinitionCatalog,
    );
    const folderId =
      input.folderId == null ? null : input.folderId.toLowerCase();
    if (
      folderId !== null &&
      !(await readFolderScope(client, input)).permits(
        folderId,
        'workflow:create',
      )
    )
      throw new WorkflowNotFoundError('Folder is not visible');
    const name = input.name;
    const command = {
      workspaceId: input.workspaceId,
      operation: 'workflow.create',
      scope: input.actorId,
      idempotencyKey: input.idempotencyKey,
    };
    const stored = await claimCommand(client, {
      ...command,
      request: {
        name,
        graph,
        requestedWorkflowId: input.id ?? null,
        ...(folderId === null ? {} : { folderId }),
      },
      resourceId: workflowId,
    });
    let createdId = workflowId;
    if (stored !== null) {
      createdId = createdResultSchema.parse(stored).workflowId;
      await context.requireAuthor(client, input.workspaceId, {
        actorId: input.actorId,
        workflowId: createdId,
        capability: 'workflow:read',
      });
    } else {
      await requireWorkflowCallTargets(client, input, graph);
      await requireConnectionBindings(client, input, graph);
      await lockArtifactReferences(
        client,
        input.workspaceId,
        graph,
        input.actorId,
      );
      const db = drizzle(client);
      await db
        .insert(workflows)
        .values({
          id: workflowId,
          workspaceId: input.workspaceId,
          name,
          lifecycleStatus: 'active',
          activationStatus: 'inactive',
          createdBy: input.actorId,
        })
        .catch(rethrowQueryFailure);
      if (folderId !== null)
        await db
          .insert(workflowOrganizationState)
          .values({
            workspaceId: input.workspaceId,
            workflowId,
            folderId,
            revision: 1,
          })
          .catch(rethrowQueryFailure);
      await db
        .insert(workflowDrafts)
        .values({
          workflowId,
          workspaceId: input.workspaceId,
          revision: 1,
          graphJson: sql`${JSON.stringify(graph)}::json`,
          updatedBy: input.actorId,
        })
        .catch(rethrowQueryFailure);
      await appendAuditFact(client, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: 'workflow.created',
        targetType: 'workflow',
        targetId: workflowId,
        requestId: input.requestId ?? null,
        traceId: input.traceId ?? null,
        metadata: { revision: 1 },
      });
      await completeCommand(client, command, { workflowId });
    }
    const [row] = await drizzle(client)
      .select({ workflow: workflowProjection, draft: draftProjection })
      .from(workflows)
      .innerJoin(
        workflowDrafts,
        and(
          eq(workflowDrafts.workspaceId, workflows.workspaceId),
          eq(workflowDrafts.workflowId, workflows.id),
        ),
      )
      .where(
        and(
          eq(workflows.workspaceId, input.workspaceId),
          eq(workflows.id, createdId),
        ),
      )
      .catch(rethrowQueryFailure);
    if (row === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    return Object.freeze({
      workflowId: createdId,
      workflow: Object.freeze(row.workflow),
      draft: projectDraft(row.draft, definitionCatalog),
    });
  });
}

async function saveDraft(
  context: WorkflowAuthoringWriteContext,
  input: SaveWorkflowDraftInput,
): Promise<WorkflowDraftRecord> {
  const representationTag = input.representationTag;
  return context.transact(input.workspaceId, input.actorId, async (client) => {
    await context.requireAuthor(client, input.workspaceId, {
      actorId: input.actorId,
      workflowId: input.workflowId,
    });
    const { definitionCatalog, placementDefinitionCatalog } = context.catalogs;
    const graph = input.graphJson;
    const expected = input.expectedRevision;
    const workflowId = input.workflowId;
    const [currentRow] = await readActiveDraft(client, {
      workspaceId: input.workspaceId,
      workflowId,
    });
    if (currentRow === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const currentDraft = projectDraft(currentRow, definitionCatalog);
    const currentTag = draftRepresentationTag(workflowId, currentDraft);
    if (currentTag !== representationTag || currentDraft.revision !== expected)
      throwRevisionConflict(workflowId, currentDraft);
    context.requirePlaceable(
      currentDraft.graphJson,
      graph,
      placementDefinitionCatalog,
    );
    await requireWorkflowCallTargets(
      client,
      input,
      graph,
      currentDraft.graphJson,
    );
    await requireConnectionBindings(
      client,
      input,
      graph,
      currentDraft.graphJson,
    );
    await lockArtifactReferences(
      client,
      input.workspaceId,
      graph,
      input.actorId,
    );
    const db = drizzle(client);
    const visible = db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, input.workspaceId),
          eq(workflows.id, workflowId),
          eq(workflows.lifecycleStatus, 'active'),
        ),
      );
    const [row] = await db
      .update(workflowDrafts)
      .set({
        graphJson: sql`${JSON.stringify(graph)}::json`,
        revision: sql`${workflowDrafts.revision}+1`,
        updatedBy: input.actorId,
        updatedAt: sql`transaction_timestamp()`,
      })
      .where(
        and(
          eq(workflowDrafts.workspaceId, input.workspaceId),
          eq(workflowDrafts.workflowId, workflowId),
          eq(workflowDrafts.revision, expected),
          exists(visible),
        ),
      )
      .returning(draftProjection)
      .catch(rethrowQueryFailure);
    if (row === undefined) {
      const [latest] = await readActiveDraft(client, {
        workspaceId: input.workspaceId,
        workflowId,
      });
      if (latest === undefined)
        throw new WorkflowNotFoundError('Workflow is not visible');
      throwRevisionConflict(
        workflowId,
        projectDraft(latest, definitionCatalog),
      );
    }
    const saved = projectDraft(row, definitionCatalog);
    await pruneStepSamples(client, input.workspaceId, workflowId, graph);

    await appendAuditFact(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: 'workflow.draft_saved',
      targetType: 'workflow',
      targetId: input.workflowId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata: { previousRevision: expected, revision: saved.revision },
    });
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

function readActiveDraft(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; workflowId: string }>,
) {
  return drizzle(client)
    .select(draftProjection)
    .from(workflowDrafts)
    .innerJoin(
      workflows,
      and(
        eq(workflows.workspaceId, workflowDrafts.workspaceId),
        eq(workflows.id, workflowDrafts.workflowId),
      ),
    )
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, input.workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
}
