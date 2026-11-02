import type { ConnectionScope } from '../../../tenant-access/resources/connections/scope.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import {
  workflows,
  workflowVersions,
  workflowVersionPromotions,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { FolderScope } from '../../../shared/contract.js';
import { workflowScopeSql } from '../../../shared/scope.queries.js';
import type { PoolClient } from 'pg';
import {
  isWorkflowCallDefinition,
  workflowCallConfigSchema,
  parseWorkflowGraphDraft,
  validateWorkflowGraph,
  validateCallDependencyClosure,
  summarizeWorkflowCalls,
  WORKFLOW_GRAPH_LIMITS,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';
import { mapPromotionNodes, type PromotionGraphBudget } from './graph.js';
import type { PromotionSource } from './source.queries.js';
import { inspectPromotionRequirements } from './requirements.queries.js';

export async function rebindPromotionCalls(
  client: PoolClient,
  sourceWorkspaceId: string,
  {
    targetWorkspaceId,
    resources,
    source,
    graph,
    report,
  }: Readonly<{
    targetWorkspaceId: string;
    resources: FolderScope;
    source: PromotionSource;
    graph: WorkflowGraph;
    report: (requirement: WorkflowPromotionRequirement) => void;
  }>,
): Promise<WorkflowGraph> {
  const replacements = new Map<
    string,
    ReturnType<typeof workflowCallConfigSchema.parse>
  >();
  const pending: WorkflowGraph[] = [graph];
  for (const level of pending)
    for (const node of level.nodes) {
      if (node.structured !== undefined) pending.push(node.structured.body);
      if (!isWorkflowCallDefinition(node.definition)) continue;
      const pin = workflowCallConfigSchema.parse(node.config).target;
      const workflow = alias(workflows, 'workflow'),
        version = workflowVersions,
        origin = workflowVersionPromotions;
      const [match] = await drizzle(client)
        .select({
          workflow_id: version.workflowId,
          id: version.id,
          checksum: version.checksum,
        })
        .from(origin)
        .innerJoin(
          version,
          and(
            eq(version.workspaceId, origin.workspaceId),
            eq(version.workflowId, origin.workflowId),
            eq(version.id, origin.versionId),
          ),
        )
        .innerJoin(
          workflow,
          and(
            eq(workflow.workspaceId, version.workspaceId),
            eq(workflow.id, version.workflowId),
          ),
        )
        .where(
          and(
            eq(origin.workspaceId, targetWorkspaceId),
            eq(origin.sourceWorkspaceId, sourceWorkspaceId),
            eq(origin.sourceWorkflowId, pin.workflowId),
            eq(origin.sourceVersionId, pin.workflowVersionId),
            eq(origin.sourceChecksum, pin.executableChecksum),
            workflowScopeSql(resources, sql`${workflow.id}`),
            eq(workflow.lifecycleStatus, 'active'),
          ),
        )
        .orderBy(desc(origin.createdAt), desc(version.id))
        .limit(1)
        .for('share', { of: workflow })
        .catch(rethrowQueryFailure);
      report({
        workflowId: source.workflowId,
        nodeId: node.id,
        kind: 'call',
        name: node.label ?? node.id,
        status: match === undefined ? 'missing' : 'ready',
        detail:
          match === undefined
            ? 'Promote this exact child version first, then publish or approve it in the target workspace. A newer version is not a substitute.'
            : 'Pinned to the published target counterpart of this exact source child version.',
        dependency: {
          workflowId: pin.workflowId,
          versionId: pin.workflowVersionId,
        },
        ...(match === undefined ? {} : { targetVersionId: match.id }),
      });
      if (match !== undefined)
        replacements.set(node.id, {
          target: {
            workflowId: match.workflow_id,
            workflowVersionId: match.id,
            executableChecksum: match.checksum,
          },
        });
    }
  return mapPromotionNodes(graph, (node) => {
    const replacement = replacements.get(node.id);
    return replacement === undefined
      ? node
      : { ...node, config: { target: { ...replacement.target } } };
  });
}

/** Inspect the actual immutable destination closure, using the engine's closure bounds. */
export async function inspectPromotionCallDependencies(
  client: PoolClient,
  workspaceId: string,
  {
    source,
    targetWorkflowId,
    resources,
    connections,
    graph,
    budget,
    report,
  }: Readonly<{
    source: PromotionSource;
    targetWorkflowId: string | null;
    resources: FolderScope;
    connections: ConnectionScope;
    graph: WorkflowGraph;
    budget: PromotionGraphBudget;
    report: (requirement: WorkflowPromotionRequirement) => void;
  }>,
): Promise<void> {
  const validation = validateWorkflowGraph(graph);
  if (!validation.ok) return;
  const root = summarizeWorkflowCalls(
    {
      workspaceId,
      workflowId: targetWorkflowId ?? source.workflowId,
      workflowVersionId: source.versionId,
      executableChecksum: source.checksum,
    },
    graph,
    validation.expandedInvocations,
  );
  await validateCallDependencyClosure(
    root,
    async (pin) => {
      const [row] = await drizzle(client)
        .select({
          graph_json: workflowVersions.graphJson,
          checksum: workflowVersions.checksum,
          workflow_id: workflowVersions.workflowId,
          visible: sql<boolean>`${workflowScopeSql(resources, sql`${workflowVersions.workflowId}`)}`,
        })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workspaceId, workspaceId),
            eq(workflowVersions.workflowId, pin.workflowId),
            eq(workflowVersions.id, pin.workflowVersionId),
          ),
        )
        .catch(rethrowQueryFailure);
      if (row === undefined)
        throw new Error('A reviewed target Call version is unavailable.');
      const child = parseWorkflowGraphDraft(row.graph_json);
      budget.add(child);
      // Immutable children delegate execution, not discovery of private requirements.
      if (row.visible)
        for (const requirement of await inspectPromotionRequirements(
          client,
          workspaceId,
          { workflowId: source.workflowId, graph: child, scope: connections },
        ))
          report({
            ...requirement,
            dependency: {
              workflowId: pin.workflowId,
              versionId: pin.workflowVersionId,
            },
            targetVersionId: pin.workflowVersionId,
          });
      const checked = validateWorkflowGraph(child);
      return summarizeWorkflowCalls(
        {
          workspaceId,
          workflowId: row.workflow_id,
          workflowVersionId: pin.workflowVersionId,
          executableChecksum: row.checksum,
        },
        child,
        checked.expandedInvocations,
      );
    },
    WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations,
  );
}
