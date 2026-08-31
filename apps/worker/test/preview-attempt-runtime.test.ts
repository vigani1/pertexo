import { createHash, randomUUID } from 'node:crypto';

import type { PreviewAttemptLease } from '@pertexo/database/testing';
import {
  SLACK_BOT_TOKEN_CONNECTION_SLOT,
  SLACK_SEND_MESSAGE_DEFINITION,
  SLACK_SEND_MESSAGE_EXECUTOR,
  EMAIL_SEND_NOTIFICATION_DEFINITION,
  EMAIL_SEND_NOTIFICATION_EXECUTOR,
  RESEND_API_KEY_CONNECTION_SLOT,
} from '@pertexo/integrations';
import { HttpRequestExecutorError } from '@pertexo/integrations/server';
import {
  PLATFORM_REGISTRY_RELEASE_SLACK_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
  platformServingRegistryRelease,
} from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
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
    executionDeadlineAt: new Date(Date.now() + 60_000),
    retentionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
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
  it('executes the active idempotent email action through the production preview path', async () => {
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const secret = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: 'resend_api_key',
        apiKey: 're_123456789_secret',
        fromEmail: 'sender@example.com',
      }),
    );
    const beforeDispatch = vi.fn(
      (input?: Readonly<{ providerDispatchBinding?: string }>) => {
        void input;
        return Promise.resolve();
      },
    );
    const sendNotification = vi.fn(
      async (input: { beforeDispatch(): Promise<void> }) => {
        await input.beforeDispatch();
        return {
          kind: 'succeeded' as const,
          emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
        };
      },
    );
    const release = composeExecutableCompatibilityRelease(
      PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
    );
    const lease = {
      ...leaseFixture({
        config: { timeoutMillis: 5_000 },
        configVersion: 1,
        connectionRefs: { [RESEND_API_KEY_CONNECTION_SLOT]: connectionId },
        definition: EMAIL_SEND_NOTIFICATION_DEFINITION,
        id: 'node-1',
        inputMappings: {
          toEmail: { kind: 'literal' as const, value: 'recipient@example.com' },
          subject: { kind: 'literal' as const, value: 'Preview' },
          text: { kind: 'literal' as const, value: 'Preview body' },
        },
      }),
      compatibilityReleaseEpoch: release.epoch,
      compatibilityReleaseFingerprint: release.fingerprint,
      definitionKey: EMAIL_SEND_NOTIFICATION_DEFINITION.key,
      dryRun: 'not_supported' as const,
      executorKey: EMAIL_SEND_NOTIFICATION_EXECUTOR.key,
      mayCauseExternalSideEffect: true,
      mayContactProvider: true,
      sideEffectClass: 'idempotent_with_key' as const,
    };
    const invoker = createPlatformPreviewNodeInvoker({
      registry: createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
        {
          emailSendNotification: { client: { sendNotification } },
        },
      ),
      releaseCohort: 'email_activation',
    });
    await expect(
      invoker.invoke({
        lease,
        runtime: {
          workspaceId: lease.workspaceId,
          runId: lease.previewRunId,
          nodeRunId: lease.previewAttemptId,
          attemptId: lease.previewAttemptId,
          attemptNumber: 1,
          nodeId: lease.nodeId,
          invocationKey: lease.nodeId,
          sideEffectClass: 'idempotent_with_key',
          providerIdempotencyKey: 'stable-preview-resend-key',
          beforeDispatch,
          connections: {
            resolve: () =>
              Promise.resolve({
                connectionId,
                providerKey: 'email',
                authType: 'resend_api_key',
                secretVersionId,
                secret,
              }),
            assertCurrent: () => Promise.resolve(),
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      output: { emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' },
      status: 'succeeded',
    });
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'stable-preview-resend-key',
      }),
    );
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledWith({
      connectionFence: {
        connectionId,
        expectedAuthType: 'resend_api_key',
        expectedProviderKey: 'email',
        secretVersionId,
      },
      providerDispatchBinding: `email:v1:sha256:${createHash('sha256')
        .update(`email\0${connectionId}\0${secretVersionId}`)
        .digest('hex')}`,
    });
  });
  it('executes the active Slack action through the production preview path', async () => {
    const connectionId = randomUUID();
    const secret = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken: 'xoxb-123456789-secret',
      }),
    );
    const beforeDispatch = vi.fn(() => Promise.resolve());
    const assertCurrent = vi.fn(() => Promise.resolve());
    const sendMessage = vi.fn(
      async (input: { beforeDispatch(): Promise<void> }) => {
        await input.beforeDispatch();
        return {
          kind: 'succeeded' as const,
          channelId: 'C123ABC',
          messageTs: '1724412345.000100',
        };
      },
    );
    const release = composeExecutableCompatibilityRelease(
      PLATFORM_REGISTRY_RELEASE_SLACK_ACTIVE,
    );
    const lease = {
      ...leaseFixture({
        config: { timeoutMillis: 5_000 },
        configVersion: 1,
        connectionRefs: {
          [SLACK_BOT_TOKEN_CONNECTION_SLOT]: connectionId,
        },
        definition: SLACK_SEND_MESSAGE_DEFINITION,
        id: 'node-1',
        inputMappings: {
          channelId: { kind: 'literal' as const, value: 'C123ABC' },
          text: { kind: 'literal' as const, value: 'preview deployment' },
        },
      }),
      compatibilityReleaseEpoch: release.epoch,
      compatibilityReleaseFingerprint: release.fingerprint,
      definitionKey: SLACK_SEND_MESSAGE_DEFINITION.key,
      dryRun: 'not_supported' as const,
      executorKey: SLACK_SEND_MESSAGE_EXECUTOR.key,
      mayCauseExternalSideEffect: true,
      mayContactProvider: true,
      sideEffectClass: 'unsafe' as const,
    };
    const invoker = createPlatformPreviewNodeInvoker({
      registry: createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_SLACK_ACTIVE,
        { slackSendMessage: { client: { sendMessage } } },
      ),
      releaseCohort: 'slack_activation',
    });

    await expect(
      invoker.invoke({
        lease,
        runtime: {
          workspaceId: lease.workspaceId,
          runId: lease.previewRunId,
          nodeRunId: lease.previewAttemptId,
          attemptId: lease.previewAttemptId,
          attemptNumber: 1,
          nodeId: lease.nodeId,
          invocationKey: lease.nodeId,
          sideEffectClass: 'unsafe',
          beforeDispatch,
          connections: {
            resolve: () =>
              Promise.resolve({
                connectionId,
                providerKey: 'slack',
                authType: 'slack_bot_token',
                secretVersionId: randomUUID(),
                secret,
              }),
            assertCurrent,
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      output: {
        channelId: 'C123ABC',
        messageTs: '1724412345.000100',
      },
      status: 'succeeded',
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects Wait with a stable suspension-not-supported outcome', async () => {
    const execute = vi.fn();
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute } as never,
      releaseCohort: 'core',
    });
    const lease = {
      ...leaseFixture({
        config: { durationSeconds: 60 },
        configVersion: 1,
        connectionRefs: {},
        definition: { key: 'core.wait', version: 1 },
        id: 'node-1',
        inputMappings: {},
      }),
      definitionKey: 'core.wait',
      executorKey: 'core.wait',
    };

    await expect(
      invoker.invoke({ lease, signal: new AbortController().signal }),
    ).resolves.toEqual({
      safeErrorCode: 'preview.suspension_not_supported',
      status: 'failed',
    });
    expect(execute).not.toHaveBeenCalled();
  });

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
});
