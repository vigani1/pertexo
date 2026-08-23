import { randomUUID } from 'node:crypto';

import type { PreviewAttemptLease } from '@pertexo/database';
import { HttpRequestExecutorError } from '@pertexo/integrations/server';
import { platformServingRegistryRelease } from '@pertexo/node-catalog';
import { composeExecutableCompatibilityRelease } from '@pertexo/workflow-engine';
import { describe, expect, it, vi } from 'vitest';

import { createPlatformPreviewNodeInvoker } from '../src/execution/preview-attempt-runtime.js';

function leaseFixture(
  executableNode: PreviewAttemptLease['executableNode'],
): PreviewAttemptLease {
  const release = composeExecutableCompatibilityRelease(
    platformServingRegistryRelease('core'),
  );
  return {
    attemptFenceToken: 1,
    compatibilityReleaseEpoch: release.epoch,
    compatibilityReleaseFingerprint: release.fingerprint,
    definitionKey: 'core.set',
    definitionVersion: 1,
    dryRun: 'not_supported',
    executableNode,
    executorKey: 'core.set',
    executorVersion: 1,
    expiresAt: new Date(Date.now() + 60_000),
    input: {
      kind: 'inline',
      schemaVersion: 1,
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

describe('platform preview node invoker', () => {
  it('resolves mappings through the production resolver before execution', async () => {
    const execute = vi.fn((request: { input: unknown }) =>
      Promise.resolve({ kind: 'succeeded' as const, output: request.input }),
    );
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute } as never,
      releaseCohort: 'core',
    });
    const lease = leaseFixture({
      config: {},
      configVersion: 1,
      connectionRefs: {},
      definition: { key: 'core.set', version: 1 },
      id: 'node-1',
      inputMappings: {
        doubled: {
          expression: 'runInput.count * 2',
          kind: 'expression',
          language: 'jsonata',
          policyVersion: 1,
        },
        name: { kind: 'run_input', path: '$.name' },
      },
    });

    await expect(
      invoker.invoke({
        lease,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      output: { doubled: 8, name: 'Ada' },
      status: 'succeeded',
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ input: { doubled: 8, name: 'Ada' } }),
    );
  });

  it('fails closed when the persisted executable pins disagree', async () => {
    const execute = vi.fn();
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute } as never,
      releaseCohort: 'core',
    });
    const lease = leaseFixture({
      config: {},
      configVersion: 1,
      connectionRefs: {},
      definition: { key: 'core.manual', version: 1 },
      id: 'node-1',
      inputMappings: {},
    });

    await expect(
      invoker.invoke({
        lease,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      safeErrorCode: 'preview.executable_invalid',
      status: 'failed',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves cancellation while resolving preview input mappings', async () => {
    const execute = vi.fn();
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute } as never,
      releaseCohort: 'core',
    });
    const lease = leaseFixture({
      config: {},
      configVersion: 1,
      connectionRefs: {},
      definition: { key: 'core.set', version: 1 },
      id: 'node-1',
      inputMappings: {
        name: { kind: 'run_input', path: '$.name' },
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      invoker.invoke({ lease, signal: controller.signal }),
    ).resolves.toEqual({
      safeErrorCode: 'execution.canceled',
      status: 'canceled',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps unsafe possibly-dispatched HTTP cancellation to outcome_unknown', async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(
        new HttpRequestExecutorError(
          { kind: 'outcome_unknown', errorKind: 'provider' },
          true,
        ),
      );
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute } as never,
      releaseCohort: 'core',
    });
    const lease = {
      ...leaseFixture({
        config: {},
        configVersion: 1,
        connectionRefs: {},
        definition: { key: 'core.set', version: 1 },
        id: 'node-1',
        inputMappings: {},
      }),
      mayCauseExternalSideEffect: true,
      mayContactProvider: true,
      sideEffectClass: 'unsafe' as const,
    };

    await expect(
      invoker.invoke({ lease, signal: new AbortController().signal }),
    ).resolves.toEqual({
      safeErrorCode: 'preview.outcome_unknown',
      status: 'outcome_unknown',
    });
  });
});
