import { randomUUID } from 'node:crypto';

import { jobIdForOutboxEvent } from '@pertexo/queue';

import type {
  PreviewAttemptLease,
  PreviewTerminalOutcome,
} from '@pertexo/core/testing';
import { vi } from 'vitest';
import type { createPreviewAttemptHandler } from '../../../src/previews/handler.js';
import type {
  PreviewAttemptHandlerDependencies,
  PreviewAttemptRunStore,
  PreviewNodeInvoker,
} from '../../../src/previews/handler.js';

export const workspaceId = randomUUID();

export const outboxEventId = randomUUID();

export const previewRunId = randomUUID();

export const previewAttemptId = randomUUID();

export function leaseFixture(): PreviewAttemptLease {
  return {
    attemptFenceToken: 1,
    definitionKey: 'core.set',
    definitionVersion: 1,
    dryRun: 'not_supported',
    executableNode: Object.freeze({
      config: { value: 1 },
      id: 'node-1',
    }),
    executorKey: 'core.set',
    executorVersion: 1,
    executionDeadlineAt: new Date(Date.now() + 4 * 60 * 1_000),
    retentionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    input: { kind: 'inline', value: { n: 1 } },
    mayCauseExternalSideEffect: false,
    mayContactProvider: true,
    nodeId: 'node-1',
    operationKey: 'set',
    previewAttemptId,
    previewRunId,
    providerKey: 'core',
    sideEffectClass: 'safe',
    workflowId: randomUUID(),
    workspaceId,
  };
}

export function deliveryFixture(): Parameters<
  ReturnType<typeof createPreviewAttemptHandler>['handle']
>[0] {
  return {
    data: {
      outboxEventId,
      previewAttemptId,
      previewRunId,
      traceparent: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01',
      workspaceId,
    },
    name: 'execute-preview-attempt' as const,
    transport: {
      attemptsMade: 0,
      jobId: jobIdForOutboxEvent(outboxEventId),
    },
  };
}

export function context(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

interface StoreCalls {
  bindings: (string | undefined)[];
  connectionFences: unknown[];
  claims: number;
  completions: PreviewTerminalOutcome[];
  completionSignals: (AbortSignal | undefined)[];
  dispatches: number;
}

export function fakeStore(
  overrides: Partial<{
    beat: { runExecutionDeadlineAt: Date };
    claimKind: 'duplicate';
    heartbeatError: Error;
    lease: PreviewAttemptLease;
  }> = {},
): { calls: StoreCalls; store: PreviewAttemptRunStore } {
  const calls: StoreCalls = {
    bindings: [],
    connectionFences: [],
    claims: 0,
    completions: [],
    completionSignals: [],
    dispatches: 0,
  };
  const store: PreviewAttemptRunStore = {
    claim: () => {
      calls.claims += 1;
      if (overrides.claimKind === 'duplicate')
        return Promise.resolve({ kind: 'duplicate' });
      return Promise.resolve({
        kind: 'claimed',
        lease: overrides.lease ?? leaseFixture(),
      });
    },
    complete: ({ outcome, signal }) => {
      calls.completions.push(outcome);
      calls.completionSignals.push(signal);
      return Promise.resolve({ kind: 'committed' });
    },
    heartbeat: () => {
      if (overrides.heartbeatError !== undefined)
        return Promise.reject(overrides.heartbeatError);
      const beat = overrides.beat ?? {
        runExecutionDeadlineAt: new Date(Date.now() + 60 * 60 * 1_000),
      };
      return Promise.resolve({
        attemptLeaseExpiresAt: new Date(Date.now() + 30 * 1_000),
        runExecutionDeadlineAt: beat.runExecutionDeadlineAt,
      });
    },
    markDispatched: ({ connectionFence, providerDispatchBinding }) => {
      calls.bindings.push(providerDispatchBinding);
      calls.connectionFences.push(connectionFence);
      calls.dispatches += 1;
      return Promise.resolve('committed');
    },
  };
  return { calls, store };
}

export function succeededInvoker(output: unknown): {
  invoker: PreviewNodeInvoker;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(() =>
    Promise.resolve({
      output,
      status: 'succeeded' as const,
    }),
  );
  return { invoke, invoker: { invoke } };
}

export function deps(
  store: PreviewAttemptRunStore,
  invoker: PreviewNodeInvoker,
): PreviewAttemptHandlerDependencies {
  return {
    heartbeatIntervalMillis: 10,
    invoker,
    leaseDurationSeconds: 30,
    runStore: store,
    workerId: 'worker-preview-test',
  };
}
