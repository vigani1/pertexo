import { HttpRequestExecutorError } from '@pertexo/integrations/server';

import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { expect, it, vi } from 'vitest';

import { createPlatformPreviewNodeInvoker, leaseFixture } from './fixture.js';

export function registerPreservesCancellationResolvingPreviewInputMappings(): void {
  it('preserves cancellation while resolving preview input mappings', async () => {
    const execute = vi.fn();
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute } as never,
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
          { possiblyDispatched: true },
        ),
      );
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute } as never,
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

  it('maps a generic unsafe possibly-dispatched cancellation to outcome_unknown', async () => {
    const execute = vi.fn().mockRejectedValue(
      new NodeExecutorFailure({
        kind: 'canceled',
        errorKind: 'canceled',
        possiblyDispatched: true,
      }),
    );
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute } as never,
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
      sideEffectClass: 'unsafe' as const,
    };
    await expect(
      invoker.invoke({ lease, signal: new AbortController().signal }),
    ).resolves.toEqual({
      safeErrorCode: 'preview.outcome_unknown',
      status: 'outcome_unknown',
    });
  });

  it('maps idempotent possibly-dispatched cancellation to outcome_unknown', async () => {
    const execute = vi.fn().mockRejectedValue(
      new NodeExecutorFailure({
        kind: 'canceled',
        errorKind: 'canceled',
        possiblyDispatched: true,
      }),
    );
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute } as never,
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
      providerIdempotencyKey: 'stable-provider-key',
      sideEffectClass: 'idempotent_with_key' as const,
    };

    await expect(
      invoker.invoke({ lease, signal: new AbortController().signal }),
    ).resolves.toEqual({
      safeErrorCode: 'preview.outcome_unknown',
      status: 'outcome_unknown',
    });
  });
}
