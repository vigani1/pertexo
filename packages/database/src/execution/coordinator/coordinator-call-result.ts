import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CoordinatorAdvanceDelivery } from './coordinator-run-store-contract.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { prepareInlineWorkflowExecutionValueV3 } from '../artifacts/execution-value-representation.js';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '../artifacts/execution-value-representation.js';
import { prepareWorkflowExecutionResultIdentityV1 } from '../artifacts/workflow-execution-result-identity.js';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import type { NativeCoordinatorResultValuePreparer } from './coordinator-native-value-read-contract.js';
import { parseWorkflowExecutionValueSnapshot } from '../node-attempts/node-attempt-call-input-record.js';
import { assertCoordinatorNotAborted } from './coordinator-run-store-transactions.js';
import {
  serializeStoredExecutionValueV1,
  serializeWorkflowExecutionJsonValueV3,
  type StoredExecutionValueV1,
} from '../stored-execution-value.js';

/** Plain original-byte parameters, not authority; prepared outside the write transaction. */
export async function prepareCoordinatorCallResult(
  input: Readonly<{
    runId: string;
    workspaceId: string;
    workflowVersionId: string;
    plan: ParsedTransitionPlan;
    delivery: CoordinatorAdvanceDelivery;
    resultSelector: WorkflowCallableDeclarationV1['resultSelector'];
    signal: AbortSignal;
    freshValue: JsonValue;
    prepareValue?: NativeCoordinatorResultValuePreparer;
  }>,
) {
  const result = input.plan.callableResult;
  if (result?.kind !== 'succeeded') return;
  const bytes = serializeWorkflowExecutionJsonValueV3(input.freshValue);
  if (bytes !== serializeWorkflowExecutionJsonValueV3(result.value))
    throw new TypeError('Native fresh result differs from the proposed result');
  assertCoordinatorNotAborted(input.signal);
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
  let reference: StoredExecutionValueV1 | undefined =
    prepareInlineWorkflowExecutionValueV3(input.freshValue);
  if (input.prepareValue !== undefined) {
    const prepared = await input.prepareValue({
      owner: {
        kind: 'run_result',
        workspaceId: input.workspaceId,
        runId: input.runId,
        workflowVersionId: input.workflowVersionId,
        expectedRevision: input.plan.expectedRevision,
        resultRevision: input.plan.checkpoint.revision,
        resultIdentity: binding.identity,
        delivery: input.delivery,
      },
      value: JSON.parse(bytes) as JsonValue,
      signal: input.signal,
    });
    assertCoordinatorNotAborted(input.signal);
    const snapshot = parseWorkflowExecutionValueSnapshot({
      ...prepared,
      ...(prepared.reference.kind === 'inline'
        ? { serializedValue: bytes }
        : {}),
    });
    if (
      snapshot.sha256 !== sha256 ||
      snapshot.byteLength !== byteLength ||
      (snapshot.reference.kind === 'inline' &&
        serializeWorkflowExecutionJsonValueV3(snapshot.reference.value) !==
          bytes)
    )
      throw new TypeError(
        'Native result preparation differs from actual producer bytes',
      );
    reference = snapshot.reference;
  }
  if (reference === undefined)
    throw new Error('Native result artifact persistence is not implemented');
  assertCoordinatorNotAborted(input.signal);
  return Object.freeze([
    input.runId,
    input.plan.checkpoint.revision,
    JSON.stringify(input.delivery),
    serializeStoredExecutionValueV1(reference),
    sha256,
    byteLength,
    reference.kind === 'inline' ? bytes : null,
    JSON.stringify(result.sources),
    binding.serializedIdentity,
  ]);
}

/** Final existing CAS/receipt writer independently rederives every acceptance guard. */
export async function persistCoordinatorCallResult(
  client: PoolClient,
  parameters: Awaited<ReturnType<typeof prepareCoordinatorCallResult>>,
): Promise<void> {
  if (parameters === undefined) return;
  await client.query(
    `select app.record_workflow_call_run_result($1::uuid,$2::integer,$3::jsonb,$4::jsonb,$5::text,$6::integer,$7::text,$8::jsonb,$9::text)`,
    [...parameters],
  );
}
