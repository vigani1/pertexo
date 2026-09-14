import {
  claimPreviewDelivery,
  completePreviewAttempt,
  acquireDatabasePool,
  heartbeatPreviewLease,
  markPreviewDispatched,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
} from '@pertexo/database/execution';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/execution';
import {
  platformExecutableRegistryHistory,
  resolvePlatformNodeDefinitionForRelease,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  resolveSingleNodePreviewInput,
  WorkflowEngineError,
} from '@pertexo/workflow-engine';
import { JsonataEvaluator } from '@pertexo/workflow-model/expressions';
import type { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { unrecoverableQueueError } from '@pertexo/queue';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { z } from 'zod';

import type {
  PreviewInvocationOutcome,
  PreviewAttemptRunStore,
  PreviewNodeInvoker,
} from './preview-attempt-handler.js';
import { PreviewAttemptHandlerStateError } from './preview-attempt-handler.js';

export type { PreviewAttemptHandler } from './preview-attempt-handler.js';

const leasePickSchema = z.object({
  attemptFenceToken: z.number().int().nonnegative(),
  previewAttemptId: z.uuid(),
  previewRunId: z.uuid(),
  workspaceId: z.uuid(),
});

function previewLeaseAuthority(lease: unknown) {
  const scope = leasePickSchema.parse(lease);
  return Object.freeze({
    attemptFenceToken: scope.attemptFenceToken,
    previewAttemptId: scope.previewAttemptId,
    previewRunId: scope.previewRunId,
    workspaceId: scope.workspaceId,
  });
}

const previewExecutableNodeSchema = z
  .object({
    config: z.record(z.string(), z.json()),
    configVersion: z.number().int().positive(),
    connectionRefs: z.record(z.string(), z.string().min(1)),
    definition: z
      .object({ key: z.string().min(1), version: z.number().int().positive() })
      .strict(),
    id: z.string().min(1).max(256),
    inputMappings: z.record(z.string(), z.json()),
  })
  .strict();

/**
 * Durable store adapter over the preview execution seam. Every call opens
 * its own tenant-scoped transaction through the shared fail-closed
 * primitive, so the handler stays transport-only.
 */
export function createDatabasePreviewAttemptRunStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): PreviewAttemptRunStore & { close(): Promise<void> } {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const store: PreviewAttemptRunStore = {
    claim: (input) => claimPreviewDelivery(pool, input),
    markDispatched: async ({
      connectionFence,
      lease,
      providerDispatchBinding,
      signal,
      workerId,
    }) => {
      return markPreviewDispatched(pool, {
        lease: previewLeaseAuthority(lease),
        ...(connectionFence === undefined ? {} : { connectionFence }),
        ...(providerDispatchBinding === undefined
          ? {}
          : { providerDispatchBinding }),
        ...(signal === undefined ? {} : { signal }),
        workerId,
      });
    },
    heartbeat: async ({ lease, leaseDurationSeconds, signal, workerId }) => {
      return heartbeatPreviewLease(pool, {
        lease: previewLeaseAuthority(lease),
        leaseDurationSeconds,
        ...(signal === undefined ? {} : { signal }),
        workerId,
      });
    },
    complete: async ({ delivery, lease, outcome, signal, workerId }) => {
      return completePreviewAttempt(pool, {
        delivery,
        lease: previewLeaseAuthority(lease),
        outcome,
        ...(signal === undefined ? {} : { signal }),
        workerId,
      });
    },
  };
  return Object.freeze({
    ...store,
    close: () => lease.close(),
  });
}

function releaseDescriptionKey(epoch: number, fingerprint: string): string {
  return `${String(epoch)}:${fingerprint}`;
}

/**
 * Resolves the exact pinned release identity against this worker artifact's
 * compatibility history with no latest-version fallback, then executes the
 * pinned definition through the platform registry.
 */
export function createPlatformPreviewNodeInvoker(
  dependencies: Readonly<{
    registry: ReturnType<typeof createPlatformNodeRegistryForRelease>;
    releaseCohort: PlatformReleaseCohort;
  }>,
): PreviewNodeInvoker {
  // The durable authority binds engine-composed release identities (node
  // catalogs plus this artifact's engine runtime policies), so the supported
  // set derives from exactly the same composition production uses.
  const supported = new Map(
    platformExecutableRegistryHistory(dependencies.releaseCohort).map(
      (release) => {
        const composed = composeExecutableCompatibilityRelease(release);
        return [
          releaseDescriptionKey(composed.epoch, composed.fingerprint),
          release,
        ] as const;
      },
    ),
  );
  const failedWith = (safeErrorCode: string): PreviewInvocationOutcome =>
    Object.freeze({
      safeErrorCode,
      status: 'failed',
    });
  const unknownWith = (): PreviewInvocationOutcome =>
    Object.freeze({
      safeErrorCode: 'preview.outcome_unknown',
      status: 'outcome_unknown',
    });
  const succeededWith = (output: unknown): PreviewInvocationOutcome =>
    Object.freeze({
      output,
      status: 'succeeded',
    });
  const canceledWith = (): PreviewInvocationOutcome =>
    Object.freeze({
      safeErrorCode: 'execution.canceled',
      status: 'canceled',
    });
  // Construct the evaluator only after all pure release support can no longer
  // fail, so the factory cannot strand an owned worker during setup.
  const expressionEvaluator = new JsonataEvaluator();
  const invokeOnce = async ({
    lease,
    runtime,
    signal,
  }: Parameters<
    PreviewNodeInvoker['invoke']
  >[0]): Promise<PreviewInvocationOutcome> => {
    const release = supported.get(
      releaseDescriptionKey(
        lease.compatibilityReleaseEpoch,
        lease.compatibilityReleaseFingerprint,
      ),
    );
    if (release === undefined)
      return failedWith('preview.executor_unavailable');
    if (lease.input.kind !== 'inline')
      return failedWith('preview.input_artifact_unsupported');
    try {
      const node = previewExecutableNodeSchema.parse(lease.executableNode);
      if (
        node.id !== lease.nodeId ||
        node.definition.key !== lease.definitionKey ||
        node.definition.version !== lease.definitionVersion
      )
        return failedWith('preview.executable_invalid');
      if (node.definition.key === 'core.wait' && node.definition.version === 1)
        return failedWith('preview.suspension_not_supported');
      let definition: ReturnType<
        typeof resolvePlatformNodeDefinitionForRelease
      >['manifest'];
      try {
        definition = resolvePlatformNodeDefinitionForRelease(
          release,
          node.definition,
        ).manifest;
      } catch {
        return failedWith('preview.executable_invalid');
      }
      if (
        node.configVersion !== definition.configVersion ||
        lease.executorKey !== definition.executor.key ||
        lease.executorVersion !== definition.executor.version
      )
        return failedWith('preview.executable_invalid');
      const resolvedInput = await resolveSingleNodePreviewInput({
        node,
        runInput: lease.input.value,
        signal,
        expressionEvaluator,
      });
      const result = await dependencies.registry.execute({
        config: node.config,
        connectionRefs: node.connectionRefs,
        definition: {
          key: lease.definitionKey,
          version: lease.definitionVersion,
        },
        executor: {
          key: lease.executorKey,
          version: lease.executorVersion,
        },
        // The acceptance boundary already canonicalized this inline value
        // through the stored-value codec; hand the payload straight to the
        // pinned executor.
        input: resolvedInput,
        ...(runtime === undefined ? {} : { runtime }),
        signal,
      });
      // Both registry success kinds produce a truthful output value.
      return succeededWith(result.output);
    } catch (error: unknown) {
      try {
        if (error instanceof z.ZodError)
          return failedWith('preview.executable_invalid');
        if (
          error instanceof WorkflowEngineError &&
          error.code === 'attempt_invalid'
        )
          return failedWith('preview.input_invalid');
        if (
          error instanceof WorkflowEngineError &&
          error.code === 'attempt_aborted'
        )
          return canceledWith();
      } catch {
        // Hostile rejections cannot claim a known executable/input contract.
      }
      return classifyExecutorFailure(error, lease.sideEffectClass, {
        canceledWith,
        failedWith,
        unknownWith,
      });
    }
  };
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const activeInvocations = new Set<Promise<PreviewInvocationOutcome>>();
  const invoker: PreviewNodeInvoker = {
    invoke: (input): Promise<PreviewInvocationOutcome> => {
      if (closing) return Promise.resolve(failedWith('preview.invoker_closed'));
      const invocation = invokeOnce(input);
      activeInvocations.add(invocation);
      void invocation.then(
        () => activeInvocations.delete(invocation),
        () => activeInvocations.delete(invocation),
      );
      return invocation;
    },
    close: (): Promise<void> => {
      closing = true;
      closePromise ??= (async (): Promise<void> => {
        await Promise.allSettled([...activeInvocations]);
        await expressionEvaluator.shutdown();
      })();
      return closePromise;
    },
  };
  return Object.freeze(invoker);
}

/**
 * A preview runs exactly one attempt: a pre-dispatch retryable failure is
 * simply failed, while an unsafe possibly-dispatched effect is unknown.
 */
function classifyExecutorFailure(
  error: unknown,
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe',
  outcomes: Readonly<{
    canceledWith: () => PreviewInvocationOutcome;
    failedWith: (safeErrorCode: string) => PreviewInvocationOutcome;
    unknownWith: () => PreviewInvocationOutcome;
  }>,
): PreviewInvocationOutcome {
  try {
    if (error instanceof NodeExecutorFailure) {
      const nonSafePossibleDispatch =
        error.possiblyDispatched && sideEffectClass !== 'safe';
      switch (error.kind) {
        case 'canceled':
          return nonSafePossibleDispatch
            ? outcomes.unknownWith()
            : outcomes.canceledWith();
        case 'outcome_unknown':
          return outcomes.unknownWith();
        case 'retry':
          return nonSafePossibleDispatch
            ? outcomes.unknownWith()
            : outcomes.failedWith(`preview.${error.errorKind}`);
        case 'failed':
          return outcomes.failedWith(`preview.${error.errorKind}`);
      }
    }
    if (isAbortError(error)) return outcomes.canceledWith();
  } catch {
    // Hostile rejections cannot supply trustworthy dispatch evidence.
  }
  return outcomes.failedWith('preview.executor_failed');
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      (error as { code?: string }).code === 'ABORT_ERR')
  );
}

export function mapPreviewHandlerError(error: unknown): unknown {
  try {
    if (error instanceof PreviewDeliveryMismatchError)
      return unrecoverableQueueError(
        'Preview delivery failed durable state verification',
      );
    if (error instanceof PreviewAttemptStateError)
      return unrecoverableQueueError(
        'Preview delivery failed durable attempt-state verification',
      );
    if (error instanceof PreviewAttemptHandlerStateError)
      return unrecoverableQueueError(
        `Preview delivery is not recoverable: ${error.code}`,
      );
  } catch {
    // Unknown objects cannot claim a durable error contract through traps.
  }
  return error;
}
