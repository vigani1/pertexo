import type { PoolClient } from 'pg';
import {
  AUTHORING_VALIDATION_BUDGET,
  AuthoringValidationUnavailableError,
} from '@pertexo/workflow-model/authoring-validation';
import type { WorkflowGraph } from '@pertexo/workflow-model/graph';
import type { WorkflowAuthoringGraphValidator } from './workflow-authoring-types.js';

const parserWaitMs =
  AUTHORING_VALIDATION_BUDGET.queueMs +
  AUTHORING_VALIDATION_BUDGET.startupMs +
  AUTHORING_VALIDATION_BUDGET.parseMs +
  AUTHORING_VALIDATION_BUDGET.terminationMs;

/** pg_settings exposes the effective connection setting in its declared unit. */
export function authoringIdleBudgetIsSafe(
  setting: unknown,
  unit: unknown,
): boolean {
  if (typeof setting !== 'string' || !/^[0-9]+$/u.test(setting)) return false;
  const multipliers: Readonly<Record<string, number>> = {
    us: 0.001,
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
  };
  if (typeof unit !== 'string') return false;
  const multiplier = multipliers[unit];
  if (multiplier === undefined) return false;
  const duration = Number(setting) * multiplier;
  // Zero means unlimited, not evidence of a bounded effective deadline.
  return (
    Number.isSafeInteger(Number(setting)) &&
    Number.isFinite(duration) &&
    duration > parserWaitMs
  );
}

/** Only idle-in-transaction applies to the off-thread wait; query_timeout does not. */
export async function admitWorkflowAuthoring(
  client: Pick<PoolClient, 'query'>,
  validator: WorkflowAuthoringGraphValidator | undefined,
  graph: WorkflowGraph,
  signal?: AbortSignal,
) {
  if (validator === undefined)
    throw new AuthoringValidationUnavailableError('not_configured');
  const result = await client.query<{ setting: string; unit: string | null }>(
    "select setting, unit from pg_settings where name = 'idle_in_transaction_session_timeout'",
  );
  const budget = result.rows[0];
  if (!authoringIdleBudgetIsSafe(budget?.setting, budget?.unit))
    throw new AuthoringValidationUnavailableError('database_budget');
  signal?.throwIfAborted();
  return validator(graph, signal === undefined ? {} : { signal });
}
