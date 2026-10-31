import {
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
} from '@pertexo/database/testing';

import {
  NodeConfigValidationError,
  NodeExecutorFailure,
  NodeInputValidationError,
} from '@pertexo/node-sdk/server';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { mapPreviewHandlerError } from '../../../src/testing.js';
import { PreviewAttemptHandlerStateError } from '../../../src/previews/handler.js';
import { createPlatformPreviewNodeInvoker, leaseFixture } from './fixture.js';

export function registerPlatformPreviewNodeInvokerClassifiesExecutorFailure(): void {
  it.each([
    [
      new NodeExecutorFailure({
        kind: 'failed',
        errorKind: 'provider',
        possiblyDispatched: false,
        safeErrorCode: 'http.pagination_too_large',
        errorSummary: 'Page 3: Lower Max pages.',
      }),
      {
        safeErrorCode: 'http.pagination_too_large',
        errorSummary: 'Page 3: Lower Max pages.',
        status: 'failed',
      },
    ],
    [
      new NodeExecutorFailure({
        kind: 'canceled',
        errorKind: 'canceled',
        possiblyDispatched: false,
      }),
      { safeErrorCode: 'execution.canceled', status: 'canceled' },
    ],
    [
      new NodeExecutorFailure({
        kind: 'retry',
        errorKind: 'rate_limit',
        possiblyDispatched: false,
      }),
      { safeErrorCode: 'preview.rate_limit', status: 'failed' },
    ],
    [
      new NodeExecutorFailure({
        kind: 'retry',
        errorKind: 'rate_limit',
        possiblyDispatched: true,
      }),
      { safeErrorCode: 'preview.rate_limit', status: 'failed' },
    ],
    [
      new NodeExecutorFailure({
        kind: 'failed',
        errorKind: 'provider',
        possiblyDispatched: false,
      }),
      { safeErrorCode: 'preview.provider', status: 'failed' },
    ],
    [
      new DOMException('aborted', 'AbortError'),
      { safeErrorCode: 'execution.canceled', status: 'canceled' },
    ],
    [
      Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }),
      { safeErrorCode: 'execution.canceled', status: 'canceled' },
    ],
    [
      new NodeInputValidationError('Use a date like 2026-10-19.'),
      {
        safeErrorCode: 'preview.input_invalid',
        errorSummary: 'Use a date like 2026-10-19.',
        status: 'failed',
      },
    ],
    [
      new NodeConfigValidationError(
        z.object({ path: z.string() }).safeParse({ path: 1 }).error,
      ),
      {
        safeErrorCode: 'preview.config_invalid',
        errorSummary:
          'Setting path: Invalid input: expected string, received number',
        status: 'failed',
      },
    ],
    [
      new Error('boom'),
      { safeErrorCode: 'preview.executor_failed', status: 'failed' },
    ],
  ] as const)('classifies executor failure %#', async (error, expected) => {
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute: () => Promise.reject(error) } as never,
    });
    const lease = leaseFixture({
      config: {},
      configVersion: 1,
      connectionRefs: {},
      definition: { key: 'core.set', version: 1 },
      id: 'node-1',
      inputMappings: {},
    });
    await expect(
      invoker.invoke({ lease, signal: new AbortController().signal }),
    ).resolves.toEqual(expected);
  });

  it('names a workspace variable missing from the captured set, without running the step', async () => {
    let executed = false;
    const invoker = createPlatformPreviewNodeInvoker({
      registry: {
        execute: () => {
          executed = true;
          return Promise.resolve({ output: {} });
        },
      } as never,
    });
    const lease = {
      ...leaseFixture({
        config: {},
        configVersion: 1,
        connectionRefs: {},
        definition: { key: 'core.set', version: 1 },
        id: 'node-1',
        inputMappings: {
          value: { kind: 'workspace_variable', name: 'ABSENT' },
        },
      }),
      variables: { PRESENT: 1 },
    };
    await expect(
      invoker.invoke({ lease, signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      safeErrorCode: 'preview.variable_missing',
      status: 'failed',
    });
    expect(executed).toBe(false);
  });

  it('maps a possibly-dispatched unsafe retry to outcome unknown', async () => {
    const invoker = createPlatformPreviewNodeInvoker({
      registry: {
        execute: () =>
          Promise.reject(
            new NodeExecutorFailure({
              kind: 'retry',
              errorKind: 'rate_limit',
              possiblyDispatched: true,
            }),
          ),
      } as never,
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

  it('fails closed for hostile executor rejections', async () => {
    const revoked = Proxy.revocable(new Error('revoked'), {});
    revoked.revoke();
    const errors = [
      new Proxy(new Error('hostile'), {
        getPrototypeOf: () => {
          throw new Error('hostile prototype');
        },
      }),
      revoked.proxy,
    ];
    for (const error of errors) {
      const invoker = createPlatformPreviewNodeInvoker({
        registry: { execute: () => Promise.reject(error) } as never,
      });
      const lease = leaseFixture({
        config: {},
        configVersion: 1,
        connectionRefs: {},
        definition: { key: 'core.set', version: 1 },
        id: 'node-1',
        inputMappings: {},
      });
      await expect(
        invoker.invoke({ lease, signal: new AbortController().signal }),
      ).resolves.toEqual({
        safeErrorCode: 'preview.executor_failed',
        status: 'failed',
      });
    }
  });

  it('maps only genuine durable preview-state errors to unrecoverable queue failures', () => {
    for (const error of [
      new PreviewDeliveryMismatchError(),
      new PreviewAttemptStateError('durable_mismatch'),
      new PreviewAttemptHandlerStateError('duplicate_dispatch'),
    ]) {
      expect(mapPreviewHandlerError(error)).toMatchObject({
        name: 'UnrecoverableError',
      });
    }
    const ordinary = new Error('ordinary');
    expect(mapPreviewHandlerError(ordinary)).toBe(ordinary);
    for (const name of [
      'PreviewDeliveryMismatchError',
      'PreviewAttemptStateError',
      'PreviewAttemptHandlerStateError',
    ]) {
      const impostor = Object.assign(new Error('hostile'), { name });
      expect(mapPreviewHandlerError(impostor)).toBe(impostor);
    }
  });
}
