import { acquireDatabasePool } from '../../platform/database-runtime.js';
import type { DatabaseRuntime } from '../../platform/database-runtime.js';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';

import type { DatabaseConfig } from '../../config.js';
import {
  assertLocalJsonCallTarget,
  checkLocalJsonCallReadiness,
} from '../../platform/local-json-call-readiness.js';
import {
  reserveNativeResultArtifact,
  inspectNativeResultArtifact,
} from '../artifacts/native-result-artifact-owner.js';
import type { CompatibilityReleaseExpectationSet } from '../../compatibility/compatibility-release.js';
import {
  parseCoordinatorExecutableCapability,
  assertNativeCoordinatorPoolAdmission,
} from './coordinator-executable-capability.js';
import {
  CoordinatorDeliveryMismatchError,
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  type AcknowledgeAdvanceDeliveryInput,
  type AcknowledgeAdvanceDeliveryResult,
  type CommitAdvancePlanInput,
  type CommitAdvancePlanResult,
  type CoordinatorAdvanceDelivery,
  type CoordinatorRunStore,
  type LoadAdvanceStateInput,
  type LoadAdvanceStateResult,
} from './coordinator-run-store-contract.js';
import { commitCoordinatorAdvancePlan } from './coordinator-run-store-commit.js';
import { checkNativeCoordinatorReadiness } from './coordinator-native-readiness.js';
import { acknowledgeCoordinatorDelivery } from './coordinator-run-store-delivery.js';
import { loadCoordinatorAdvanceState } from './coordinator-run-store-observations.js';
import type { CoordinatorCallAdmissionOptions } from './coordinator-call-admission.js';
import type {
  NativeCoordinatorResultPreparationScope,
  NativeCoordinatorControlSourceHydrator,
  NativeCoordinatorCallDeclarationHydrator,
  NativeCoordinatorResultSourceHydrator,
  NativeCoordinatorResultValuePreparer,
} from './coordinator-native-value-read-contract.js';
import {
  createNativeCoordinatorValueReads,
  parseNativeCoordinatorControlReadTimeoutMillis,
} from './coordinator-native-value-reads.js';

export {
  CoordinatorDeliveryMismatchError,
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
};
export type {
  AcknowledgeAdvanceDeliveryResult,
  CommitAdvancePlanResult,
  CoordinatorAdvanceDelivery,
  CoordinatorRunStore,
  LoadAdvanceStateResult,
};
export type CoordinatorRunStoreOptions = Readonly<{
  localJsonCallDevelopment?: boolean;
  workflowCallAdmission?: CoordinatorCallAdmissionOptions;
  callableResultEvaluator?: ExpressionEvaluator;
  /** Actual worker value lifetime P; no pool configuration mutation or fallback. */
  nativeValueControlReadTimeoutMillis?: number;
  withNativeResultPreparation?: NativeCoordinatorResultPreparationScope;
  hydrateNativeCallDeclaration?: NativeCoordinatorCallDeclarationHydrator;
  hydrateNativeResultSources?: NativeCoordinatorResultSourceHydrator;
  hydrateNativeControlSource?: NativeCoordinatorControlSourceHydrator;
  prepareNativeResultValue?: NativeCoordinatorResultValuePreparer;
  /** Exact existing release/compiler descriptions; absence means retained-only. */
  expectedCompatibilityReleases?: CompatibilityReleaseExpectationSet;
  runTimeoutFailureContextEnabled?: boolean;
  /** ADR 055: record terminal failures for the workspace inbox. */
  workspaceInboxProducerEnabled?: boolean;
  /** ADR 056: record schedule and webhook run outcomes for failure streaks. */
  workflowTriggerOutcomesEnabled?: boolean;
}>;

export function createCoordinatorRunStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
  options: CoordinatorRunStoreOptions = {},
): CoordinatorRunStore {
  // Validate before acquiring an owned pool, so invalid configuration cannot
  // strand a newly created pool/telemetry lifecycle.
  const controlReadTimeoutMillis =
    parseNativeCoordinatorControlReadTimeoutMillis(
      options.nativeValueControlReadTimeoutMillis ?? 2_000,
    );
  const capability = parseCoordinatorExecutableCapability(
    options.expectedCompatibilityReleases,
  );
  const nativeCapable = capability.nativeReleases.length > 0;
  if (nativeCapable)
    assertNativeCoordinatorPoolAdmission(
      config.connectionTimeoutMillis,
      controlReadTimeoutMillis,
    );
  if (options.localJsonCallDevelopment === true)
    assertLocalJsonCallTarget(config);
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const nativeReads = createNativeCoordinatorValueReads(
    pool,
    controlReadTimeoutMillis,
  );
  let nativeReady = false;
  const requireNativeReadiness = (): void => {
    if (!nativeReady)
      throw new Error(
        'Native coordinator adapter has not passed owner readiness',
      );
    assertNativeCoordinatorPoolAdmission(
      pool.options.connectionTimeoutMillis,
      controlReadTimeoutMillis,
    );
  };
  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal): Promise<void> => {
      if (!nativeCapable) return;
      nativeReady = false;
      if (options.localJsonCallDevelopment === true) {
        await checkLocalJsonCallReadiness(
          pool,
          config,
          capability.nativeReleases,
        );
      } else
        await checkNativeCoordinatorReadiness(
          pool,
          config.ownerRole,
          config.workerRuntimeRole,
          controlReadTimeoutMillis,
          signal,
        );
      nativeReady = true;
    },
    ...(nativeCapable
      ? {
          reserveNativeResultArtifact: (
            input: Parameters<typeof reserveNativeResultArtifact>[1],
          ) => {
            requireNativeReadiness();
            return reserveNativeResultArtifact(pool, input);
          },
          assertNativeResultArtifactReserved: (
            input: Parameters<typeof inspectNativeResultArtifact>[1],
          ) => {
            requireNativeReadiness();
            return inspectNativeResultArtifact(pool, input);
          },
          finalizeNativeResultArtifact: (
            input: Parameters<typeof inspectNativeResultArtifact>[1],
          ) => {
            requireNativeReadiness();
            return inspectNativeResultArtifact(pool, input, true);
          },
          inspectCoordinatorValueReadOwner: (
            input: Parameters<
              typeof nativeReads.inspectCoordinatorValueReadOwner
            >[0],
          ) => {
            requireNativeReadiness();
            return nativeReads.inspectCoordinatorValueReadOwner(input);
          },
          loadCallableCompletionSources: (
            input: Parameters<
              typeof nativeReads.loadCallableCompletionSources
            >[0],
          ) => {
            requireNativeReadiness();
            return nativeReads.loadCallableCompletionSources(input);
          },
          readCallableCompletionSource: (
            input: Parameters<
              typeof nativeReads.readCallableCompletionSource
            >[0],
          ) => {
            requireNativeReadiness();
            return nativeReads.readCallableCompletionSource(input);
          },
          readCoordinatorCallDeclaration: (
            input: Parameters<
              typeof nativeReads.readCoordinatorCallDeclaration
            >[0],
          ) => {
            requireNativeReadiness();
            return nativeReads.readCoordinatorCallDeclaration(input);
          },
          loadCoordinatorControlSources: (
            input: Parameters<
              typeof nativeReads.loadCoordinatorControlSources
            >[0],
          ) => {
            requireNativeReadiness();
            return nativeReads.loadCoordinatorControlSources(input);
          },
          readCoordinatorControlSource: (
            input: Parameters<
              typeof nativeReads.readCoordinatorControlSource
            >[0],
          ) => {
            requireNativeReadiness();
            return nativeReads.readCoordinatorControlSource(input);
          },
        }
      : {}),
    acknowledgeAdvanceDelivery: (input: AcknowledgeAdvanceDeliveryInput) =>
      acknowledgeCoordinatorDelivery(pool, input),
    loadAdvanceState: (input: LoadAdvanceStateInput) => {
      if (nativeCapable) requireNativeReadiness();
      return loadCoordinatorAdvanceState(
        pool,
        input,
        nativeCapable
          ? {
              controlReadTimeoutMillis,
              capability,
            }
          : undefined,
      );
    },
    commitAdvancePlan: (input: CommitAdvancePlanInput) => {
      if (nativeCapable) requireNativeReadiness();
      return commitCoordinatorAdvancePlan(pool, input, {
        ...(nativeCapable
          ? {
              nativeValueControlReadTimeoutMillis: controlReadTimeoutMillis,
              inspectNativeResultOwner:
                nativeReads.inspectCoordinatorValueReadOwner,
              ...(options.hydrateNativeControlSource === undefined
                ? {}
                : {
                    hydrateNativeControlSource:
                      options.hydrateNativeControlSource,
                  }),
              ...(options.prepareNativeResultValue === undefined
                ? {}
                : {
                    prepareNativeResultValue: options.prepareNativeResultValue,
                  }),
              ...(options.hydrateNativeResultSources === undefined
                ? {}
                : {
                    hydrateNativeResultSources:
                      options.hydrateNativeResultSources,
                  }),
              ...(options.hydrateNativeCallDeclaration === undefined
                ? {}
                : {
                    hydrateNativeCallDeclaration:
                      options.hydrateNativeCallDeclaration,
                  }),
              ...(options.withNativeResultPreparation === undefined
                ? {}
                : {
                    withNativeResultPreparation:
                      options.withNativeResultPreparation,
                  }),
            }
          : {}),
        runTimeoutFailureContextEnabled:
          options.runTimeoutFailureContextEnabled ?? false,
        workspaceInboxProducerEnabled:
          options.workspaceInboxProducerEnabled ?? false,
        workflowTriggerOutcomesEnabled:
          options.workflowTriggerOutcomesEnabled ?? false,
        ...(options.workflowCallAdmission === undefined
          ? {}
          : { workflowCallAdmission: options.workflowCallAdmission }),
        ...(options.callableResultEvaluator === undefined
          ? {}
          : { callableResultEvaluator: options.callableResultEvaluator }),
      });
    },
    close: () => lease.close(),
  });
}
