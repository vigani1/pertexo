import { PROMOTION_LIMITS, canonicalJson } from '@pertexo/workflow-model';
import { connectionScope } from '../../../shared/resources/connection-scope.repository.js';
import { readFolderScope } from '../../../shared/folder-access-facts.repository.js';
import type { PoolClient } from 'pg';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';
import { workflowDefinitionCatalogFingerprint } from '@pertexo/workflow-model/server';
import { WorkflowPromotionError } from '../workflow-promotion.errors.js';
import type {
  PromotionContext,
  PromotionScope,
} from '../workflow-promotion.types.js';
import type { PromotionGraphBudget } from './graph.js';
import type { PromotionSourceSet } from './source.repository.js';
import type { ReviewedWorkflow } from './target/target-review.types.js';
import type { Origin } from './target/target-workflows.repository.js';
import { prepareTargetWorkflow } from './target/inspect-workflow.js';
import {
  readTargetTables,
  readTargetFingerprintFacts,
} from './target.repository.js';

export async function preparePromotionTarget(
  client: PoolClient,
  context: PromotionContext,
  {
    input,
    sourceWorkspaceId,
    sources,
    budget,
  }: Readonly<{
    input: PromotionScope;
    sourceWorkspaceId: string;
    sources: PromotionSourceSet;
    budget: PromotionGraphBudget;
  }>,
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
  const tables = await readTargetTables(client, input.workspaceId, names);
  const origins: (Origin | null)[] = [];
  const state = {
    input,
    sourceWorkspaceId,
    sources,
    budget,
    scope,
    connections,
    tables,
    requirements,
    report,
  };
  for (const source of sources.workflows) {
    const result = await prepareTargetWorkflow(client, context, source, state);
    origins.push(result.origin);
    workflows.push(result.workflow);
  }
  const { tableSchemas, variableHead } = await readTargetFingerprintFacts(
    client,
    input.workspaceId,
  );
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
