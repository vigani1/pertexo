import { and, eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '../../../../schema/authoring/workflows.js';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import { readTargetOrigin, lockTargetWorkflow } from './records.queries.js';
import { workflowAccessible } from '../../../../tenant-access/resources/workflows.queries.js';
import { WorkflowNotFoundError } from '../../../workflows/errors.js';
import type { PoolClient } from 'pg';

import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';

import type { PromotionContext } from '../../contract.js';
import { promotionDigest } from '../graph.js';
import type { PromotionSource } from '../source.queries.js';

import type { ReviewedWorkflow, TargetReviewState } from './contract.js';
import type { Origin, TargetWorkflowRow } from './records.queries.js';
import { prepareTargetGraph } from './bind-graph.js';

export async function prepareTargetWorkflow(
  client: PoolClient,
  context: PromotionContext,
  source: PromotionSource,
  state: TargetReviewState,
): Promise<{ origin: Origin | null; workflow: ReviewedWorkflow }> {
  const { input, sourceWorkspaceId, sources, budget, scope, report } = state;

  input.signal?.throwIfAborted();
  const origin =
    (
      await readTargetOrigin(client, {
        workspaceId: input.workspaceId,
        sourceWorkspaceId,
        sourceWorkflowId: source.workflowId,
      })
    )[0] ?? null;
  if (
    origin !== null &&
    !(await workflowAccessible(client, scope, {
      workspaceId: input.workspaceId,
      workflowId: origin.workflow_id,
      capability: 'workflow:update',
    }))
  )
    throw new WorkflowNotFoundError('The target workflow is unavailable.');
  if (origin === null && !scope.permits(null, 'workflow:create'))
    throw new WorkflowNotFoundError('The target workflow is unavailable.');

  const target =
    origin === null
      ? undefined
      : (
          await lockTargetWorkflow(client, {
            workspaceId: input.workspaceId,
            workflowId: origin.workflow_id,
          })
        )[0];
  const targetGraph =
    target === undefined ? null : parseWorkflowGraphDraft(target.graph_json);
  if (targetGraph !== null) budget.add(targetGraph);
  if (origin !== null && target?.lifecycle_status !== 'active')
    report({
      workflowId: source.workflowId,
      kind: 'validation',
      status: 'incompatible',
      name: source.name,
      detail: 'Restore the target workflow before promoting to it.',
    });
  const collisions = (
    await drizzle(client)
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, input.workspaceId),
          eq(workflows.name, source.name),
          origin === null ? undefined : ne(workflows.id, origin.workflow_id),
        ),
      )
      .limit(1)
      .catch(rethrowQueryFailure)
  ).length;
  if (
    collisions !== 0 ||
    sources.workflows.some(
      (other) =>
        other.workflowId !== source.workflowId && other.name === source.name,
    )
  )
    report({
      workflowId: source.workflowId,
      kind: 'name',
      status: 'incompatible',
      name: source.name,
      detail:
        'An unrelated workflow has this name. Rename it or the source before promotion; existing workflows are never adopted by name.',
    });
  const directChanges = targetChangedDirectly(origin, target, targetGraph);
  const graph = await prepareTargetGraph(client, context, source, {
    ...state,
    origin,
    targetGraph,
  });
  return {
    origin,
    workflow: targetWorkflowReview(source, origin, {
      target,
      targetGraph,
      directChanges,
      graph,
    }),
  };
}

function targetChangedDirectly(
  origin: Origin | null,
  target: TargetWorkflowRow | undefined,
  targetGraph: ReturnType<typeof parseWorkflowGraphDraft> | null,
): boolean {
  return (
    origin !== null &&
    target !== undefined &&
    (target.name !== origin.target_name ||
      target.revision !== origin.draft_revision ||
      target.published_version_id !== origin.published_version_id ||
      promotionDigest(targetGraph) !== origin.graph_digest)
  );
}

function targetWorkflowReview(
  source: PromotionSource,
  origin: Origin | null,
  {
    target,
    targetGraph,
    directChanges,
    graph,
  }: Readonly<{
    target: TargetWorkflowRow | undefined;
    targetGraph: ReturnType<typeof parseWorkflowGraphDraft> | null;
    directChanges: boolean;
    graph: ReturnType<typeof parseWorkflowGraphDraft>;
  }>,
): ReviewedWorkflow {
  return {
    sourceWorkflowId: source.workflowId,
    sourceName: source.name,
    sourceVersionId: source.versionId,
    sourceVersionNumber: source.versionNumber,
    sourceChecksum: source.checksum,
    targetWorkflowId: origin?.workflow_id ?? null,
    targetName: target?.name ?? source.name,
    targetRevision: target?.revision ?? null,
    targetPublishedVersionId: target?.published_version_id ?? null,
    directChanges,
    proposedGraph: graph,
    targetGraph,
  };
}
