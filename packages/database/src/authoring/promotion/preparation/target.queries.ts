import { asc, eq } from 'drizzle-orm';
import { workspaceDataTables } from '../../../schema/data-tables.js';
import { workspaceVariables } from '../../../schema/variables.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { PROMOTION_LIMITS } from '@pertexo/workflow-model';
import { connectionScope } from '../../../tenant-access/resources/connections/scope.js';
import { readFolderScope } from '../../../tenant-access/resources/facts.queries.js';

import type { PoolClient } from 'pg';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';
import { canonicalJson } from '@pertexo/workflow-model';
import { workflowDefinitionCatalogFingerprint } from '@pertexo/workflow-model/server';

import { readTablesByNames } from '../../../data-tables/definitions.queries.js';

import { WorkflowPromotionError } from '../errors.js';
import type { PromotionContext, PromotionScope } from '../contract.js';
import type { PromotionGraphBudget } from './graph.js';
import type { PromotionSourceSet } from './source.queries.js';

import type { ReviewedWorkflow } from './target/contract.js';
import type { Origin } from './target/records.queries.js';
import { prepareTargetWorkflow } from './target/inspect-workflow.queries.js';

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
  const tables = await readTablesByNames(
    drizzle(client),
    input.workspaceId,
    names,
  ).catch(rethrowQueryFailure);
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
  const db = drizzle(client);
  const tableSchemas = await db
    .select({
      id: workspaceDataTables.id,
      name: workspaceDataTables.name,
      columns_json: workspaceDataTables.columns,
      key_column: workspaceDataTables.keyColumn,
      revision: workspaceDataTables.revision,
      has_removed_columns: workspaceDataTables.hasRemovedColumns,
    })
    .from(workspaceDataTables)
    .where(eq(workspaceDataTables.workspaceId, input.workspaceId))
    .orderBy(asc(workspaceDataTables.id))
    .for('share')
    .catch(rethrowQueryFailure);
  const [variables] = await db
    .select({ revision: workspaceVariables.revision })
    .from(workspaceVariables)
    .where(eq(workspaceVariables.workspaceId, input.workspaceId))
    .catch(rethrowQueryFailure);
  const variableHead = variables?.revision ?? 0;
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
