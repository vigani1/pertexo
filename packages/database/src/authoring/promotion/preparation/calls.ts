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
import type { PromotionSource } from './source.js';
import { inspectPromotionRequirements } from './requirements.js';

export async function rebindPromotionCalls(
  client: PoolClient,
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
  source: PromotionSource,
  graph: WorkflowGraph,
  report: (requirement: WorkflowPromotionRequirement) => void,
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
      const match = (
        await client.query<{
          workflow_id: string;
          id: string;
          checksum: string;
        }>(
          `select version.workflow_id,version.id,version.checksum from app.workflow_version_promotions origin
       join app.workflow_versions version on version.workspace_id=origin.workspace_id and version.workflow_id=origin.workflow_id and version.id=origin.version_id
       join app.workflows workflow on workflow.workspace_id=version.workspace_id and workflow.id=version.workflow_id
       where origin.workspace_id=$1 and origin.source_workspace_id=$2 and origin.source_workflow_id=$3 and origin.source_version_id=$4 and origin.source_checksum=$5 and workflow.lifecycle_status='active'
       order by origin.created_at desc,version.id desc limit 1 for share of workflow`,
          [
            targetWorkspaceId,
            sourceWorkspaceId,
            pin.workflowId,
            pin.workflowVersionId,
            pin.executableChecksum,
          ],
        )
      ).rows[0];
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
  source: PromotionSource,
  targetWorkflowId: string | null,
  graph: WorkflowGraph,
  budget: PromotionGraphBudget,
  report: (requirement: WorkflowPromotionRequirement) => void,
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
      const row = (
        await client.query<{
          graph_json: unknown;
          checksum: string;
          workflow_id: string;
        }>(
          'select graph_json,checksum,workflow_id from app.workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',
          [workspaceId, pin.workflowId, pin.workflowVersionId],
        )
      ).rows[0];
      if (row === undefined)
        throw new Error('A reviewed target Call version is unavailable.');
      const child = parseWorkflowGraphDraft(row.graph_json);
      budget.add(child);
      for (const requirement of await inspectPromotionRequirements(
        client,
        workspaceId,
        source.workflowId,
        child,
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
