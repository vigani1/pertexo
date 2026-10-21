import { connectionScope } from '../../../tenant-access/resources/connections/scope.js';
import { readFolderScope } from '../../../tenant-access/resources/facts.js';
import { workflowAccessible } from '../../../tenant-access/resources/workflows.js';
import { WorkflowNotFoundError } from '../../workflows/errors.js';
import type { PoolClient } from 'pg';
import {
  PROMOTION_LIMITS,
  type WorkflowPromotionPreview,
  type WorkflowPromotionRequirement,
} from '@pertexo/contracts';
import {
  canonicalJson,
  EMPTY_WORKFLOW_GRAPH,
  parseWorkflowGraphDraft,
  WorkflowPortabilityError,
  WorkflowCallDependencyError,
} from '@pertexo/workflow-model';
import { workflowDefinitionCatalogFingerprint } from '@pertexo/workflow-model/server';
import { collectArtifactReferences } from '../../../artifacts/references.js';
import {
  TABLE_COLUMNS,
  projectTable,
  type StoredTable,
} from '../../../data-tables/read.js';
import { admitWorkflowAuthoring } from '../../workflows/admission.js';
import { lockWorkspaceVariableNames } from '../../../variables/read.js';
import {
  WorkflowPromotionError,
  type PromotionContext,
  type PromotionScope,
} from '../contract.js';
import {
  promotionDigest,
  mapPromotionNodes,
  type PromotionGraphBudget,
} from './graph.js';
import type { PromotionSourceSet } from './source.js';
import { rebindPromotionTable } from './tables.js';
import { rebindPromotionConnections } from './connections.js';
import {
  rebindPromotionCalls,
  inspectPromotionCallDependencies,
} from './calls.js';
import { inspectPromotionRequirements } from './requirements.js';

type ReviewedWorkflow = WorkflowPromotionPreview['workflows'][number];
interface Origin {
  workflow_id: string;
  graph_digest: string;
  target_name: string;
  draft_revision: number;
  published_version_id: string | null;
  promotion_id: string;
}
export async function preparePromotionTarget(
  client: PoolClient,
  context: PromotionContext,
  input: PromotionScope,
  sourceWorkspaceId: string,
  sources: PromotionSourceSet,
  budget: PromotionGraphBudget,
) {
  const workflows: ReviewedWorkflow[] = [];
  const scope = await readFolderScope(client, input);
  const connections = connectionScope(input, scope.role, 'connection:use');
  const requirements: WorkflowPromotionRequirement[] = [];
  const seenRequirements = new Set<string>();
  const report = (requirement: WorkflowPromotionRequirement) => {
    const key = canonicalJson(requirement);
    if (seenRequirements.has(key)) return;
    seenRequirements.add(key);
    if (requirements.length >= PROMOTION_LIMITS.requirements)
      throw new WorkflowPromotionError(
        'limit',
        'These workflows exceed the promotion requirement limit. Select fewer workflows.',
      );
    requirements.push(requirement);
  };
  const names = [...new Set(sources.tables.map((table) => table.name))];
  const tables =
    names.length === 0
      ? []
      : (
          await client.query<StoredTable>(
            `select ${TABLE_COLUMNS} from app.workspace_data_tables where workspace_id=$1 and name=any($2::text[]) order by id for share`,
            [input.workspaceId, names],
          )
        ).rows.map(projectTable);
  const origins: (Origin | null)[] = [];
  for (const source of sources.workflows) {
    input.signal?.throwIfAborted();
    const origin =
      (
        await client.query<Origin>(
          'select workflow_id,graph_digest,target_name,draft_revision,published_version_id,promotion_id from app.workflow_promotion_origins where workspace_id=$1 and source_workspace_id=$2 and source_workflow_id=$3',
          [input.workspaceId, sourceWorkspaceId, source.workflowId],
        )
      ).rows[0] ?? null;
    if (
      origin !== null &&
      !(await workflowAccessible(
        client,
        scope,
        input.workspaceId,
        origin.workflow_id,
        'workflow:update',
      ))
    )
      throw new WorkflowNotFoundError('The target workflow is unavailable.');
    if (origin === null && !scope.permits(null, 'workflow:create'))
      throw new WorkflowNotFoundError('The target workflow is unavailable.');
    origins.push(origin);
    const target =
      origin === null
        ? undefined
        : (
            await client.query<{
              name: string;
              revision: number;
              graph_json: unknown;
              published_version_id: string | null;
              lifecycle_status: string;
            }>(
              `select workflow.name,workflow.published_version_id,workflow.lifecycle_status,draft.revision,draft.graph_json from app.workflows workflow join app.workflow_drafts draft on draft.workspace_id=workflow.workspace_id and draft.workflow_id=workflow.id where workflow.workspace_id=$1 and workflow.id=$2 for update of workflow,draft`,
              [input.workspaceId, origin.workflow_id],
            )
          ).rows[0];
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
      await client.query(
        'select id from app.workflows where workspace_id=$1 and name=$2 and ($3::uuid is null or id<>$3) limit 1',
        [input.workspaceId, source.name, origin?.workflow_id ?? null],
      )
    ).rowCount;
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
    const directChanges =
      origin !== null &&
      target !== undefined &&
      (target.name !== origin.target_name ||
        target.revision !== origin.draft_revision ||
        target.published_version_id !== origin.published_version_id ||
        promotionDigest(targetGraph) !== origin.graph_digest);
    let graph = source.graph;
    if (collectArtifactReferences(graph).length > 0)
      report({
        workflowId: source.workflowId,
        kind: 'file',
        status: 'incompatible',
        name: source.name,
        detail:
          'This version contains a workspace file reference. Replace it with a runtime file mapping before promotion.',
      });
    try {
      graph = await rebindPromotionConnections(
        client,
        input.workspaceId,
        connections,
        source,
        sources,
        context.catalogs,
        report,
      );
      graph = mapPromotionNodes(graph, (node) =>
        rebindPromotionTable(node, sources.tables, tables, (requirement) => {
          report({ workflowId: source.workflowId, ...requirement });
        }),
      );
      graph = await rebindPromotionCalls(
        client,
        sourceWorkspaceId,
        input.workspaceId,
        scope,
        source,
        graph,
        report,
      );
      context.requirePlaceable(
        targetGraph ?? EMPTY_WORKFLOW_GRAPH,
        graph,
        context.catalogs.placementDefinitionCatalog,
      );
      for (const requirement of await inspectPromotionRequirements(
        client,
        input.workspaceId,
        source.workflowId,
        graph,
        connections,
      ))
        report(requirement);
      const validation = await admitWorkflowAuthoring(
        client,
        context.catalogs.validateAuthoringGraph,
        graph,
        {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          workspaceVariableNames: await lockWorkspaceVariableNames(
            client,
            input.workspaceId,
          ),
        },
      );
      for (const issue of validation.issues)
        report({
          workflowId: source.workflowId,
          kind: 'validation',
          status: 'incompatible',
          name: source.name,
          detail: issue.message.slice(0, 512),
        });
      if (
        !requirements.some(
          (item) =>
            item.workflowId === source.workflowId &&
            item.kind === 'call' &&
            item.status === 'missing',
        )
      )
        await inspectPromotionCallDependencies(
          client,
          input.workspaceId,
          source,
          origin?.workflow_id ?? null,
          scope,
          connections,
          graph,
          budget,
          report,
        );
    } catch (error) {
      if (
        !(error instanceof WorkflowPortabilityError) &&
        !(error instanceof WorkflowCallDependencyError)
      )
        throw error;
      report({
        workflowId: source.workflowId,
        kind: 'validation',
        status: 'incompatible',
        name: source.name,
        detail:
          error instanceof WorkflowPortabilityError
            ? 'This version is not portable under the current node catalog. Review its configuration and credential-like literals.'
            : 'The target Call dependency closure is incompatible. Review the exact child versions and expansion bounds.',
      });
    }
    workflows.push({
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
    });
  }
  const tableSchemas = (
    await client.query<{
      id: string;
      name: string;
      columns_json: unknown;
      key_column: string | null;
      revision: number;
      has_removed_columns: boolean;
    }>(
      'select id,name,columns_json,key_column,revision,has_removed_columns from app.workspace_data_tables where workspace_id=$1 order by id for share',
      [input.workspaceId],
    )
  ).rows;
  const variableHead =
    (
      await client.query<{ revision: number }>(
        'select revision from app.workspace_variables where workspace_id=$1',
        [input.workspaceId],
      )
    ).rows[0]?.revision ?? 0;
  return {
    workflows,
    requirements,
    fingerprintFacts: {
      origins,
      variableHead,
      tables: tableSchemas,
      catalog: workflowDefinitionCatalogFingerprint(
        context.catalogs.definitionCatalog,
      ),
    },
  };
}
