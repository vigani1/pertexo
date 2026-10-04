import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CoordinatorAdvanceDelivery } from './coordinator-run-store-contract.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { prepareInlineWorkflowExecutionValueV3 } from '../artifacts/execution-value-representation.js';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '../artifacts/execution-value-representation.js';
import { prepareWorkflowExecutionResultIdentityV1 } from '../artifacts/workflow-execution-result-identity.js';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import {
  serializeStoredExecutionValueV1,
  serializeWorkflowExecutionJsonValueV3,
} from '../stored-execution-value.js';

/** Plain original-byte parameters, not authority; prepared outside the write transaction. */
export function prepareCoordinatorCallResult(
  input: Readonly<{
    runId: string;
    workspaceId: string;
    workflowVersionId: string;
    plan: ParsedTransitionPlan;
    delivery: CoordinatorAdvanceDelivery;
    resultSelector: WorkflowCallableDeclarationV1['resultSelector'];
  }>,
) {
  const result = input.plan.callableResult;
  if (result?.kind !== 'succeeded') return;
  const bytes = serializeWorkflowExecutionJsonValueV3(result.value);
  const reference = prepareInlineWorkflowExecutionValueV3(result.value);
  if (reference === undefined)
    throw new Error('Native result artifact persistence is not implemented');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const byteLength = Buffer.byteLength(bytes, 'utf8');
  const binding = prepareWorkflowExecutionResultIdentityV1({
    workspaceId: input.workspaceId,
    runId: input.runId,
    workflowVersionId: input.workflowVersionId,
    delivery: input.delivery,
    expectedRevision: input.plan.expectedRevision,
    resultRevision: input.plan.checkpoint.revision,
    resultSelector: input.resultSelector,
    sources: result.sources,
    value: {
      sha256,
      byteLength,
      mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
    },
  });
  return Object.freeze([
    input.runId,
    input.plan.checkpoint.revision,
    JSON.stringify(input.delivery),
    serializeStoredExecutionValueV1(reference),
    sha256,
    byteLength,
    bytes,
    JSON.stringify(result.sources),
    binding.serializedIdentity,
  ]);
}

/** Final existing CAS/receipt writer independently rederives every acceptance guard. */
export async function persistCoordinatorCallResult(
  client: PoolClient,
  parameters: ReturnType<typeof prepareCoordinatorCallResult>,
): Promise<void> {
  if (parameters === undefined) return;
  await client.query(
    `select app.record_workflow_call_run_result($1::uuid,$2::integer,$3::jsonb,$4::jsonb,$5::text,$6::integer,$7::text,$8::jsonb,$9::text)`,
    [...parameters],
  );
}
