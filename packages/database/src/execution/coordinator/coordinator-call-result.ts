import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CoordinatorAdvanceDelivery } from './coordinator-run-store-contract.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { prepareInlineWorkflowExecutionValueV3 } from '../artifacts/execution-value-representation.js';
import {
  serializeStoredExecutionValueV1,
  serializeWorkflowExecutionJsonValueV3,
} from '../stored-execution-value.js';

/** Result production is part of the established terminal checkpoint/receipt transaction. */
export async function persistCoordinatorCallResult(
  client: PoolClient,
  input: Readonly<{
    runId: string;
    plan: ParsedTransitionPlan;
    delivery: CoordinatorAdvanceDelivery;
  }>,
): Promise<void> {
  const result = input.plan.callableResult;
  if (result?.kind !== 'succeeded') return;
  const bytes = serializeWorkflowExecutionJsonValueV3(result.value);
  const reference = prepareInlineWorkflowExecutionValueV3(result.value);
  if (reference === undefined)
    throw new TypeError('Native result artifact persistence is unavailable');
  await client.query(
    `select app.record_workflow_call_run_result($1::uuid,$2::integer,$3::jsonb,$4::jsonb,$5::text,$6::integer,$7::text,$8::jsonb)`,
    [
      input.runId,
      input.plan.checkpoint.revision,
      JSON.stringify(input.delivery),
      serializeStoredExecutionValueV1(reference),
      createHash('sha256').update(bytes).digest('hex'),
      Buffer.byteLength(bytes, 'utf8'),
      bytes,
      JSON.stringify(result.sources),
    ],
  );
}
