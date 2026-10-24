import type { PoolClient } from 'pg';

import type { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  EMPTY_WORKFLOW_GRAPH,
  WorkflowPortabilityError,
  WorkflowCallDependencyError,
} from '@pertexo/workflow-model';

import { collectArtifactReferences } from '../../../../artifacts/references/repository.js';

import { admitWorkflowAuthoring } from '../../../workflows/admission.js';
import { lockWorkspaceVariableNames } from '../../../../variables/settings.queries.js';
import type { PromotionContext } from '../../contract.js';
import { mapPromotionNodes } from '../graph.js';
import type { PromotionSource } from '../source.js';
import { rebindPromotionTable } from '../tables.js';
import { rebindPromotionConnections } from '../connections.js';
import {
  rebindPromotionCalls,
  inspectPromotionCallDependencies,
} from '../calls.js';
import { inspectPromotionRequirements } from '../requirements.js';
import type { Origin, TargetReviewState } from './contract.js';

export async function prepareTargetGraph(
  client: PoolClient,
  context: PromotionContext,
  source: PromotionSource,
  state: TargetReviewState &
    Readonly<{
      origin: Origin | null;
      targetGraph: ReturnType<typeof parseWorkflowGraphDraft> | null;
    }>,
) {
  const {
    input,
    sourceWorkspaceId,
    sources,
    budget,
    scope,
    connections,
    tables,
    requirements,
    report,
    origin,
    targetGraph,
  } = state;
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
    graph = await rebindPromotionConnections(client, input.workspaceId, {
      scope: connections,
      source,
      sources,
      catalogs: context.catalogs,
      report,
    });
    graph = mapPromotionNodes(graph, (node) =>
      rebindPromotionTable(node, sources.tables, tables, (requirement) => {
        report({ workflowId: source.workflowId, ...requirement });
      }),
    );
    graph = await rebindPromotionCalls(client, sourceWorkspaceId, {
      targetWorkspaceId: input.workspaceId,
      resources: scope,
      source,
      graph,
      report,
    });
    context.requirePlaceable(
      targetGraph ?? EMPTY_WORKFLOW_GRAPH,
      graph,
      context.catalogs.placementDefinitionCatalog,
    );
    for (const requirement of await inspectPromotionRequirements(
      client,
      input.workspaceId,
      { workflowId: source.workflowId, graph, scope: connections },
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
      await inspectPromotionCallDependencies(client, input.workspaceId, {
        source,
        targetWorkflowId: origin?.workflow_id ?? null,
        resources: scope,
        connections,
        graph,
        budget,
        report,
      });
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

  return graph;
}
