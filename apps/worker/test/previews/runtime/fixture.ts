import { randomUUID } from 'node:crypto';
import type { PreviewAttemptLease } from '@pertexo/core/testing';

import { createPlatformPreviewNodeInvoker as createUnownedPlatformPreviewNodeInvoker } from '../../../src/testing.js';
import type { PreviewNodeInvoker } from '../../../src/previews/handler.js';

const ownedInvokers = new Set<PreviewNodeInvoker>();

export function createPlatformPreviewNodeInvoker(
  ...input: Parameters<typeof createUnownedPlatformPreviewNodeInvoker>
): ReturnType<typeof createUnownedPlatformPreviewNodeInvoker> {
  const invoker = createUnownedPlatformPreviewNodeInvoker(...input);
  ownedInvokers.add(invoker);
  return invoker;
}

export function leaseFixture(
  executableNode: PreviewAttemptLease['executableNode'],
): PreviewAttemptLease {
  return {
    attemptFenceToken: 1,
    definitionKey: 'core.set',
    definitionVersion: 1,
    dryRun: 'not_supported',
    executableNode,
    executorKey: 'core.set',
    executorVersion: 1,
    executionDeadlineAt: new Date(Date.now() + 60_000),
    retentionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    input: {
      kind: 'inline',
      value: { count: 4, name: 'Ada' },
    },
    mayCauseExternalSideEffect: false,
    mayContactProvider: false,
    nodeId: 'node-1',
    previewAttemptId: randomUUID(),
    previewRunId: randomUUID(),
    sideEffectClass: 'safe',
    workflowId: randomUUID(),
    workspaceId: randomUUID(),
  };
}

export async function cleanAppsWorkerTestPreviewsRuntimeTestRuntimeTestTsFixture() {
  await Promise.all(
    [...ownedInvokers].map(async (invoker) => invoker.close?.()),
  );
  ownedInvokers.clear();
}
