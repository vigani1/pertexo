import { readDurationSettingMillis } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  AuthoringValidationUnavailableError,
  type WorkflowAuthoringValidationOptions,
} from '@pertexo/workflow-model/server';
import { authoringIdleBudgetIsSafe } from './idle-budget.js';
import type { WorkflowAuthoringGraphValidator } from './authoring-dependencies.types.js';

/** Only idle-in-transaction applies to the off-thread wait; query_timeout does not. */
export async function admitWorkflowAuthoring(
  client: Pick<PoolClient, 'query'>,
  validator: WorkflowAuthoringGraphValidator | undefined,
  graph: WorkflowGraph,
  options: WorkflowAuthoringValidationOptions = {},
) {
  if (validator === undefined)
    throw new AuthoringValidationUnavailableError('not_configured');
  const idleTimeoutMillis = await readDurationSettingMillis(
    client,
    'idle_in_transaction_session_timeout',
  );
  if (!authoringIdleBudgetIsSafe(idleTimeoutMillis))
    throw new AuthoringValidationUnavailableError('database_budget');
  options.signal?.throwIfAborted();
  return validator(graph, options);
}
