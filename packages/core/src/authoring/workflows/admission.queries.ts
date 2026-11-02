import { sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  AuthoringValidationUnavailableError,
  type WorkflowAuthoringValidationOptions,
} from '@pertexo/workflow-model/server';
import { authoringIdleBudgetIsSafe } from './idle-budget.js';
import type { WorkflowAuthoringGraphValidator } from './types.js';

/** Only idle-in-transaction applies to the off-thread wait; query_timeout does not. */
export async function admitWorkflowAuthoring(
  client: Pick<PoolClient, 'query'>,
  validator: WorkflowAuthoringGraphValidator | undefined,
  graph: WorkflowGraph,
  options: WorkflowAuthoringValidationOptions = {},
) {
  if (validator === undefined)
    throw new AuthoringValidationUnavailableError('not_configured');
  const query = new QueryBuilder()
    .select({
      setting: sql<string>`setting`.as('setting'),
      unit: sql<string | null>`unit`.as('unit'),
    })
    .from(sql`pg_settings`)
    .where(sql`name='idle_in_transaction_session_timeout'`);
  const statement = query.toSQL();
  const result = await client.query<(typeof query)['_']['result'][number]>(
    statement.sql,
    statement.params,
  );
  const budget = result.rows[0];
  if (!authoringIdleBudgetIsSafe(budget?.setting, budget?.unit))
    throw new AuthoringValidationUnavailableError('database_budget');
  options.signal?.throwIfAborted();
  return validator(graph, options);
}
