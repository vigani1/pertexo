import {
  claimPreviewDelivery,
  completePreviewAttempt,
  heartbeatPreviewLease,
  markPreviewDispatched,
  type PreviewTerminalOutcome,
} from '@pertexo/database';
import type { DatabaseConfig } from '@pertexo/database';
import {
  platformExecutableRegistryHistory,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import { composeExecutableCompatibilityRelease } from '@pertexo/workflow-engine';
import type { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { unrecoverableQueueError } from '@pertexo/queue';
import { Pool } from 'pg';
import { z } from 'zod';

import {
  createPreviewAttemptHandler,
  type PreviewAttemptRunStore,
  type PreviewNodeInvoker,
} from './preview-attempt-handler.js';

export { createPreviewAttemptHandler };
export type {
  PreviewAttemptHandler,
  PreviewAttemptHandlerDependencies,
  PreviewAttemptRunStore,
  PreviewNodeInvoker,
  PreviewRuntimeCapabilityFactories,
} from './preview-attempt-handler.js';

const leasePickSchema = z.object({
  attemptFenceToken: z.number().int().nonnegative(),
  previewAttemptId: z.uuid(),
  previewRunId: z.uuid(),
});

const workspaceScopeSchema = z.object({
  workspaceId: z.uuid(),
});

/**
 * Durable store adapter over the preview execution seam. Every call opens
 * its own tenant-scoped transaction through the shared fail-closed
 * primitive, so the handler stays transport-only.
 */
export function createDatabasePreviewAttemptRunStore(
  config: DatabaseConfig,
): PreviewAttemptRunStore & { close(): Promise<void> } {
  const pool = new Pool(config);
  const store: PreviewAttemptRunStore = {
    claim: (input) => claimPreviewDelivery(pool, input),
    markDispatched: async ({ lease, signal, workerId }) => {
      const scope = leasePickSchema.parse(lease);
      const parsedWorkspace = workspaceScopeSchema.parse(lease);
      return markPreviewDispatched(pool, {
        lease: {
          attemptFenceToken: scope.attemptFenceToken,
          previewAttemptId: scope.previewAttemptId,
          previewRunId: scope.previewRunId,
          workspaceId: parsedWorkspace.workspaceId,
        },
        ...(signal === undefined ? {} : { signal }),
        workerId,
      });
    },
    heartbeat: async ({ lease, leaseDurationSeconds, signal, workerId }) => {
      const scope = leasePickSchema.parse(lease);
      const parsedWorkspace = workspaceScopeSchema.parse(lease);
      return heartbeatPreviewLease(pool, {
        lease: {
          attemptFenceToken: scope.attemptFenceToken,
          previewAttemptId: scope.previewAttemptId,
          previewRunId: scope.previewRunId,
          workspaceId: parsedWorkspace.workspaceId,
        },
        leaseDurationSeconds,
        ...(signal === undefined ? {} : { signal }),
        workerId,
      });
    },
    complete: async ({ delivery, lease, outcome, signal, workerId }) => {
      const scope = leasePickSchema.parse(lease);
      const parsedWorkspace = workspaceScopeSchema.parse(lease);
      return completePreviewAttempt(pool, {
        delivery,
        lease: {
          attemptFenceToken: scope.attemptFenceToken,
          previewAttemptId: scope.previewAttemptId,
          previewRunId: scope.previewRunId,
          workspaceId: parsedWorkspace.workspaceId,
        },
        outcome,
        ...(signal === undefined ? {} : { signal }),
        workerId,
      });
    },
  };
  return Object.freeze({
    ...store,
    close: async (): Promise<void> => {
      await pool.end();
    },
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
  const supported = new Set(
    platformExecutableRegistryHistory(dependencies.releaseCohort).map(
      (release) => {
        const composed = composeExecutableCompatibilityRelease(release);
        return releaseDescriptionKey(composed.epoch, composed.fingerprint);
      },
    ),
  );
  const failedWith = (safeErrorCode: string): PreviewTerminalOutcome =>
    Object.freeze({
      safeErrorCode,
      status: 'failed',
    });
  const unknownWith = (): PreviewTerminalOutcome =>
    Object.freeze({
      safeErrorCode: 'preview.outcome_unknown',
      status: 'outcome_unknown',
    });
  const succeededWith = (output: unknown): PreviewTerminalOutcome =>
    Object.freeze({
      output,
      status: 'succeeded',
    }) as PreviewTerminalOutcome;
  const canceledWith = (): PreviewTerminalOutcome =>
    Object.freeze({
      safeErrorCode: 'execution.canceled',
      status: 'canceled',
    });
  const invoker: PreviewNodeInvoker = {
    invoke: async ({
      lease,
      runtime,
      signal,
    }): Promise<PreviewTerminalOutcome> => {
      if (
        !supported.has(
          releaseDescriptionKey(
            lease.compatibilityReleaseEpoch,
            lease.compatibilityReleaseFingerprint,
          ),
        )
      )
        return failedWith('preview.executor_unavailable');
      if (lease.input.kind !== 'inline')
        return failedWith('preview.input_artifact_unsupported');
      const node = lease.executableNode as Record<string, unknown>;
      try {
        const result = await dependencies.registry.execute({
          config: node.config ?? null,
          connectionRefs: (node.connectionRefs ?? {}) as Record<string, string>,
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
          input: lease.input.value,
          ...(runtime === undefined ? {} : { runtime }),
          signal,
        });
        // Both registry success kinds produce a truthful output value.
        void result.kind;
        return succeededWith(result.output);
      } catch (error: unknown) {
        return classifyExecutorFailure(error, {
          canceledWith,
          failedWith,
          unknownWith,
        });
      }
    },
  };
  return Object.freeze(invoker);
}

/**
 * Executor adapters expose ADR 007 decisions on their error surface
 * (`decision.kind` plus `possiblyDispatched`). A preview runs exactly one
 * attempt: a pre-dispatch retryable failure is simply failed, while only a
 * possibly-dispatched effect can become outcome_unknown.
 */
function classifyExecutorFailure(
  error: unknown,
  outcomes: Readonly<{
    canceledWith: () => PreviewTerminalOutcome;
    failedWith: (safeErrorCode: string) => PreviewTerminalOutcome;
    unknownWith: () => PreviewTerminalOutcome;
  }>,
): PreviewTerminalOutcome {
  const decision = (
    error as { decision?: { errorKind?: string; kind?: string } }
  ).decision;
  if (typeof decision?.kind === 'string') {
    const dispatched =
      (error as { possiblyDispatched?: boolean }).possiblyDispatched === true;
    switch (decision.kind) {
      case 'canceled':
        return outcomes.canceledWith();
      case 'outcome_unknown':
        return outcomes.unknownWith();
      case 'retry':
        return dispatched
          ? outcomes.unknownWith()
          : outcomes.failedWith(`preview.${safeKind(decision.errorKind)}`);
      case 'failed':
        return outcomes.failedWith(`preview.${safeKind(decision.errorKind)}`);
      default:
        break;
    }
  }
  if (isAbortError(error)) return outcomes.canceledWith();
  return outcomes.failedWith('preview.executor_failed');
}

function safeKind(errorKind: string | undefined): string {
  return typeof errorKind === 'string' && /^[a-z_]{1,64}$/u.test(errorKind)
    ? errorKind
    : 'provider';
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      (error as { code?: string }).code === 'ABORT_ERR')
  );
}

export function mapPreviewHandlerError(error: unknown): unknown {
  if (
    error instanceof Error &&
    (error.name === 'PreviewDeliveryMismatchError' ||
      error.name === 'PreviewAttemptStateError')
  )
    return unrecoverableQueueError(
      error.name === 'PreviewDeliveryMismatchError'
        ? 'Preview delivery failed durable state verification'
        : `Preview delivery is not recoverable: ${error.message}`,
    );
  return error;
}
