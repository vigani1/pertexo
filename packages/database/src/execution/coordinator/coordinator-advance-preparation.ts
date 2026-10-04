import type { Pool } from 'pg';
import {
  CoordinatorPlanInvalidError,
  coordinatorDeliverySchema,
  coordinatorIdentitySchema as identitySchema,
  type CommitAdvancePlanInput,
  type CoordinatorAdvanceDelivery,
} from './coordinator-run-store-contract.js';
import {
  parseTransitionPlan,
  traceparentSchema,
  transitionFingerprint,
  validateTransitionPlan,
} from './coordinator-run-store-plan.js';
import {
  assertCoordinatorNotAborted as assertNotAborted,
  withCoordinatorReadClient,
} from './coordinator-run-store-transactions.js';
import { serializeCoordinatorCheckpoint } from './coordinator-checkpoint.js';
import { prepareCoordinatorCallResult } from './coordinator-call-result.js';
import {
  loadCoordinatorCallResultAuthentication,
  verifyCoordinatorCallResultAuthentication,
} from './coordinator-call-result-authentication.js';
import { parseNativeCoordinatorInspection } from './coordinator-native-value-reads.js';
import type {
  NativeCoordinatorResultPreparationScope,
  InspectCoordinatorValueReadOwner,
  NativeCoordinatorCallDeclarationHydrator,
} from './coordinator-native-value-read-contract.js';
import { validateCoordinatorArtifactCallInputs } from './coordinator-call-input-validation.js';

type PreparationOptions = Readonly<{
  nativeValueControlReadTimeoutMillis?: number;
  withNativeResultPreparation?: NativeCoordinatorResultPreparationScope;
  inspectNativeResultOwner?: InspectCoordinatorValueReadOwner;
  hydrateNativeCallDeclaration?: NativeCoordinatorCallDeclarationHydrator;
}>;

/** Normalize the plan and prepare bounded detached values before the protected write.
 * Returned fields are parameters, never owner proof or commit authority.
 */
export async function prepareCoordinatorAdvanceParameters(
  pool: Pool,
  input: CommitAdvancePlanInput,
  options: PreparationOptions,
) {
  if (!(input.signal instanceof AbortSignal))
    throw new CoordinatorPlanInvalidError();
  assertNotAborted(input.signal);
  let workspaceId: string;
  let runId: string;
  let workflowVersionId: string;
  let traceparent: string | undefined;
  let delivery: CoordinatorAdvanceDelivery;
  try {
    workspaceId = identitySchema.parse(input.workspaceId);
    runId = identitySchema.parse(input.runId);
    workflowVersionId = identitySchema.parse(input.workflowVersionId);
    traceparent = traceparentSchema.parse(input.traceparent);
    delivery = coordinatorDeliverySchema.parse(input.delivery);
  } catch {
    throw new CoordinatorPlanInvalidError();
  }
  const plan = parseTransitionPlan(input.plan);
  validateTransitionPlan(plan, workflowVersionId);
  const checkpointJson = serializeCoordinatorCheckpoint(plan.checkpoint);
  const planFingerprint = transitionFingerprint({
    plan,
    traceparent,
    workflowVersionId,
  });

  const nativeResult =
    plan.checkpoint.schemaVersion === 3 &&
    plan.callableResult?.kind === 'succeeded';
  let preparedResult: ReturnType<typeof prepareCoordinatorCallResult>;
  const nativeCallInputs =
    plan.checkpoint.schemaVersion === 3 &&
    plan.workflowCalls?.declarations.some(
      ({ input }) => input.kind === 'artifact',
    ) === true;
  if (nativeResult || nativeCallInputs) {
    const budget = options.nativeValueControlReadTimeoutMillis;
    if (budget === undefined)
      throw new Error('Native result precommit read owner is unavailable');
    const consumer = Object.freeze({
      workspaceId,
      runId,
      workflowVersionId,
      expectedRevision: plan.expectedRevision,
      delivery,
    });
    const inspection = await withCoordinatorReadClient(
      pool,
      workspaceId,
      input.signal,
      async (client) => {
        const inspected = await client.query<{ result: unknown }>(
          'select app.inspect_native_coordinator_value_owner($1::jsonb) as result',
          [
            JSON.stringify({
              workspaceId,
              runId,
              workflowVersionId,
              expectedRevision: plan.expectedRevision,
              delivery,
            }),
          ],
        );
        if (inspected.rows.length !== 1)
          throw new CoordinatorPlanInvalidError();
        return parseNativeCoordinatorInspection(inspected.rows[0]?.result);
      },
      budget,
    );
    assertNotAborted(input.signal);
    // Inactive consumption never starts value work. Existing locked full-plan
    // CAS below remains the only exact recovery owner; no receipt-only shortcut.
    if (inspection.kind === 'active') {
      const scope = options.withNativeResultPreparation;
      const inspectOwner = options.inspectNativeResultOwner;
      if (scope === undefined || inspectOwner === undefined)
        throw new Error('Native result preparation lifetime is unavailable');
      preparedResult = await scope(
        { owner: consumer, signal: input.signal, inspectOwner },
        async (signal) => {
          assertNotAborted(signal);
          if (nativeCallInputs)
            await validateCoordinatorArtifactCallInputs(pool, {
              owner: consumer,
              declarations: plan.workflowCalls?.declarations ?? [],
              signal,
              readTimeoutMillis: budget,
              hydrate: options.hydrateNativeCallDeclaration,
            });
          if (!nativeResult) return undefined;
          const material = await withCoordinatorReadClient(
            pool,
            workspaceId,
            signal,
            (client) =>
              loadCoordinatorCallResultAuthentication(client, {
                workspaceId,
                runId,
                workflowVersionId,
                plan,
                signal,
                delivery,
                minimumInlineOnly: true,
              }),
            budget,
          );
          assertNotAborted(signal);
          if (material === undefined) throw new CoordinatorPlanInvalidError();
          // Read releases before evaluator/codec/preparation; the same scope
          // continues watching controls and joins all owned cleanup on exit.
          await verifyCoordinatorCallResultAuthentication(material, signal);
          assertNotAborted(signal);
          return prepareCoordinatorCallResult({
            workspaceId,
            runId,
            workflowVersionId,
            plan,
            delivery,
            resultSelector: material.declaration.resultSelector,
          });
        },
      );
      assertNotAborted(input.signal);
    }
  }

  return {
    workspaceId,
    runId,
    workflowVersionId,
    traceparent,
    delivery,
    plan,
    checkpointJson,
    planFingerprint,
    nativeResult,
    preparedResult,
  };
}
