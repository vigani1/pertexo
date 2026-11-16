import { TERMINAL_RUN_STATUSES } from '../statuses.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  WorkflowCallIntent,
  WorkflowTransitionPlan,
} from '@pertexo/workflow-engine';
import { prepareStoredExecutionValue } from '../../shared/stored-execution.js';
import { CoordinatorRunStateCorruptError } from '../advance/coordinator-state.errors.js';
import {
  insertCallIntent,
  markCallWaiting,
  readCallInputAttempt,
} from './call-intents.repository.js';
import { callInputMatches, callInputRefusal } from './call-intent.js';

/** Intent, wait and wakeup are saved in the parent's checkpoint transaction. */
export async function persistCallIntents(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: WorkflowTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  const { workspaceId, runId, plan } = input;
  const closed = TERMINAL_RUN_STATUSES.has(plan.checkpoint.runStatus);
  for (const intent of plan.callIntents ?? []) {
    const prepared = await preparedInput(client, workspaceId, runId, intent);
    const refusal = closed ? 'call_parent_closed' : prepared.refusal;
    const result = await insertCallIntent(client, {
      workspaceId,
      runId,
      intent,
      prepared,
      refusal,
    });
    if (result.length !== 1) throw new CoordinatorRunStateCorruptError();
    // A declaration may settle in the same transition as parent cancellation.
    // The ordinary event writer still requires a waiting logical node first.
    const waiting = await markCallWaiting(client, {
      workspaceId,
      runId,
      invocationKey: intent.invocationKey,
    });
    if (!waiting) throw new CoordinatorRunStateCorruptError();
  }
}

async function preparedInput(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  intent: WorkflowCallIntent,
): Promise<
  Readonly<{ json: string | null; checksum: string; refusal?: string }>
> {
  const row = await readCallInputAttempt(client, {
    workspaceId,
    runId,
    invocationKey: intent.invocationKey,
  });
  if (row === undefined) throw new CoordinatorRunStateCorruptError();
  const prepared = prepareStoredExecutionValue(row.output_ref);
  if (!callInputMatches(intent, row.id, prepared))
    throw new CoordinatorRunStateCorruptError();
  const checksum = createHash('sha256').update(prepared.json).digest('hex');
  const refusal = callInputRefusal(prepared);
  return {
    json: refusal === undefined ? prepared.json : null,
    checksum,
    ...(refusal === undefined ? {} : { refusal }),
  };
}
