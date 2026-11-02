import {
  appendAuditFact,
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  workflowOrganizationState,
  workflowDrafts,
  workflows,
} from '@pertexo/database/schema';
import { EMPTY_WORKFLOW_GRAPH, type Role } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../../artifacts/references/locks.repository.js';
import { readFolderScope } from '../../../shared/facts.queries.js';
import { requireWorkflowCallTargets } from '../../../tenant-access/resources/bindings.queries.js';
import { requireConnectionBindings } from '../../../tenant-access/resources/connections/bindings.queries.js';
import { requireWorkflowInScope } from '../access.js';
import type { AuthoringCatalogs } from '../catalogs.js';
import type { CreateWorkflowInput, CreateWorkflowResult } from '../contract.js';
import { WorkflowNotFoundError } from '../errors.js';
import { requirePlaceableDefinitionAdditions } from '../placement.js';
import {
  draftProjection,
  projectDraft,
  workflowProjection,
} from '../representation/records.queries.js';

type CreatedReceipt = Readonly<{ workflowId: string }>;

export async function createWorkflow(
  client: PoolClient,
  input: CreateWorkflowInput,
  { definitionCatalog, placementDefinitionCatalog }: AuthoringCatalogs,
  role: Role,
): Promise<CreateWorkflowResult> {
  const workflowId = input.id ?? generatePersistedId();
  const graph = input.emptyGraph;
  requirePlaceableDefinitionAdditions(
    EMPTY_WORKFLOW_GRAPH,
    graph,
    placementDefinitionCatalog,
  );
  const folderId = input.folderId == null ? null : input.folderId.toLowerCase();
  if (
    folderId !== null &&
    !(await readFolderScope(client, input, role)).permits(
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
  const stored = await claimCommand<CreatedReceipt>(client, {
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
    createdId = stored.workflowId;
    await requireWorkflowInScope(
      client,
      await readFolderScope(client, input, role),
      { workspaceId: input.workspaceId, workflowId: createdId },
      'workflow:read',
    );
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
}
