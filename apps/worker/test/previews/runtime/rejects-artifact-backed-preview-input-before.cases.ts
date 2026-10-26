import { createHash, randomUUID } from 'node:crypto';

import {
  EMAIL_SEND_NOTIFICATION_DEFINITION,
  EMAIL_SEND_NOTIFICATION_EXECUTOR,
  RESEND_API_KEY_CONNECTION_SLOT,
} from '@pertexo/integrations';

import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';

import { expect, it, vi } from 'vitest';

import { createPlatformPreviewNodeInvoker, leaseFixture } from './fixture.js';

export function registerRejectsArtifactBackedPreviewInputBefore(): void {
  it('rejects artifact-backed preview input before execution', async () => {
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
      inputMappings: {},
    });
    await expect(
      invoker.invoke({
        lease: {
          ...lease,
          input: {
            kind: 'artifact',
            artifactId: randomUUID(),
          } as never,
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      safeErrorCode: 'preview.input_artifact_unsupported',
      status: 'failed',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps malformed executable and mapped input boundaries separately', async () => {
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
      inputMappings: {},
    });
    await expect(
      invoker.invoke({
        lease: { ...lease, executableNode: null as never },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      safeErrorCode: 'preview.executable_invalid',
      status: 'failed',
    });
    await expect(
      invoker.invoke({
        lease: {
          ...lease,
          executableNode: {
            ...lease.executableNode,
            inputMappings: {
              upstream: {
                kind: 'node_output',
                nodeId: 'missing',
                path: '$.value',
              },
            },
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      errorSummary:
        'Input upstream uses another step’s output. Test that step first, then test this one with “Use the output from testing” switched on.',
      safeErrorCode: 'preview.input_invalid',
      status: 'failed',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes the active idempotent email action through the production preview path', async () => {
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const secret = new TextEncoder().encode(
      JSON.stringify({
        type: 'resend_api_key',
        apiKey: 're_123456789_secret',
        fromEmail: 'sender@example.com',
      }),
    );
    const beforeDispatch = vi.fn(
      (_input?: Readonly<{ providerDispatchBinding?: string }>) => {
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
      definitionKey: EMAIL_SEND_NOTIFICATION_DEFINITION.key,
      dryRun: 'not_supported' as const,
      executorKey: EMAIL_SEND_NOTIFICATION_EXECUTOR.key,
      mayCauseExternalSideEffect: true,
      mayContactProvider: true,
      sideEffectClass: 'idempotent_with_key' as const,
    };
    const invoker = createPlatformPreviewNodeInvoker({
      registry: createPlatformNodeRegistry({
        emailSendNotification: { client: { sendNotification } },
      }),
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
      providerDispatchBinding: `email:sha256:${createHash('sha256')
        .update(`email\0${connectionId}\0${secretVersionId}`)
        .digest('hex')}`,
    });
  });
}
