import {
  EMPTY_WORKFLOW_GRAPH,
  InvalidWorkflowGraphError,
  parseWorkflowGraphDraft,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  type WorkflowDefinitionCatalog,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { lockArtifactReferences } from '../../../artifacts/references/repository.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { workflowTemplateOrigins } from '../../../schema/authoring/template-origin.js';
import {
  workflowDrafts,
  workflows,
  workflowVersions,
} from '../../../schema/authoring/workflows.js';
import { auditEvents } from '../../../schema/foundation.js';
import { requireWorkflowCallTargets } from '../../../tenant-access/resources/bindings.queries.js';
import { requireConnectionBindings } from '../../../tenant-access/resources/connections/bindings.queries.js';

import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import type { WorkflowAuthoringWriteContext } from '../context.js';
import type {
  DuplicateWorkflowInput,
  WorkflowAuthoringDatabase,
} from '../contract.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../errors.js';
import {
  draftProjection,
  projectDraft,
} from '../representation/records.queries.js';

const uuid = z.uuid();
const resultSchema = z.object({ workflowId: uuid }).strict();

async function selectedGraph(
  client: PoolClient,
  input: DuplicateWorkflowInput,
  catalog: WorkflowDefinitionCatalog,
): Promise<WorkflowGraph> {
  if (input.source.kind === 'version') {
    const [row] = await drizzle(client)
      .select({ graph_json: workflowVersions.graphJson })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.workspaceId, input.workspaceId),
          eq(workflowVersions.workflowId, input.workflowId),
          eq(workflowVersions.id, input.source.versionId),
        ),
      )
      .catch(rethrowQueryFailure);
    if (row === undefined)
      throw new WorkflowNotFoundError('Workflow source is not visible');
    return parseWorkflowGraphDraft(row.graph_json);
  }
  const [row] = await drizzle(client)
    .select(draftProjection)
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, input.workflowId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow source is not visible');
  const draft = projectDraft(row, catalog);
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

export function createWorkflowDuplicationStore(
  context: WorkflowAuthoringWriteContext,
): Pick<WorkflowAuthoringDatabase, 'duplicateWorkflow'> {
  return {
    duplicateWorkflow: async (rawInput) => {
      const input = rawInput;
      return context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          return duplicateInTransaction(client, context, input);
        },
        input.signal,
      );
    },
  };
}

async function duplicateInTransaction(
  client: PoolClient,
  context: WorkflowAuthoringWriteContext,
  input: DuplicateWorkflowInput,
) {
  await context.requireAuthor(client, input.workspaceId, {
    actorId: input.actorId,
    workflowId: input.workflowId,
    capability: 'workflow:read',
  });
  // Workflow precedes draft, consistent with restore/publication/lifecycle.
  const db = drizzle(client);
  const [sourceRow] = await db
    .select({ lifecycle_status: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
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
    await context.requireAuthor(client, input.workspaceId, {
      actorId: input.actorId,
      workflowId: replay.workflowId,
      capability: 'workflow:read',
    });
    const destination = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, input.workspaceId),
          eq(workflows.id, replay.workflowId),
        ),
      )
      .for('share')
      .catch(rethrowQueryFailure);
    if (destination.length !== 1)
      throw new WorkflowNotFoundError('Workflow destination is not visible');
    return Object.freeze(replay);
  }
  if (sourceRow.lifecycle_status !== 'active')
    throw new WorkflowNotFoundError('Workflow source is not visible');
  const { definitionCatalog, placementDefinitionCatalog } = context.catalogs;
  const graph = await selectedGraph(client, input, definitionCatalog);
  context.requirePlaceable(
    EMPTY_WORKFLOW_GRAPH,
    graph,
    placementDefinitionCatalog ?? definitionCatalog,
  );
  await requireWorkflowCallTargets(client, input, graph);
  try {
    await requireConnectionBindings(client, input, graph);
  } catch (error) {
    if (error instanceof InvalidWorkflowGraphError)
      throw new WorkflowNotFoundError('Workflow connection is not visible');
    throw error;
  }
  await lockArtifactReferences(client, input.workspaceId, graph, input.actorId);
  await persistDuplicate(client, input, { destinationId, graph });
  const result = Object.freeze({ workflowId: destinationId });
  await completeCommand(client, command, result);
  return result;
}
async function persistDuplicate(
  client: PoolClient,
  input: DuplicateWorkflowInput,
  {
    destinationId,
    graph,
  }: Readonly<{ destinationId: string; graph: WorkflowGraph }>,
) {
  const db = drizzle(client);
  await db
    .insert(workflows)
    .values({
      id: destinationId,
      workspaceId: input.workspaceId,
      name: input.name,
      lifecycleStatus: 'active',
      activationStatus: 'inactive',
      createdBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
  await db
    .insert(workflowDrafts)
    .values({
      workflowId: destinationId,
      workspaceId: input.workspaceId,
      revision: 1,
      graphJson: sql`${JSON.stringify(graph)}::json`,
      updatedBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
  const origin = db
    .select({
      workspaceId: workflowTemplateOrigins.workspaceId,
      workflowId: sql<string>`${destinationId}::uuid`.as('workflow_id'),
      origin:
        sql`${workflowTemplateOrigins.origin}||'{"derivation":"inherited"}'::jsonb`.as(
          'origin',
        ),
    })
    .from(workflowTemplateOrigins)
    .where(
      and(
        eq(workflowTemplateOrigins.workspaceId, input.workspaceId),
        eq(workflowTemplateOrigins.workflowId, input.workflowId),
      ),
    );
  await db
    .insert(workflowTemplateOrigins)
    .select(origin)
    .catch(rethrowQueryFailure);
  await db
    .insert(auditEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorId,
      action: 'workflow.duplicated',
      targetType: 'workflow',
      targetId: destinationId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata: {
        sourceWorkflowId: input.workflowId,
        source: input.source,
        revision: 1,
      },
    })
    .catch(rethrowQueryFailure);
}
