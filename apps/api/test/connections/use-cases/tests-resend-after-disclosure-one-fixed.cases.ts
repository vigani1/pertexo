import { expect, it, vi } from 'vitest';
import type {
  ConnectionEmailClient,
  ConnectionTestPersistence,
} from '../../../src/connections/ports.js';
import { TestConnectionUseCase } from '../../../src/connections/use-cases/management.js';

import {
  actor,
  actorId,
  authorization,
  connectionId,
  connectionTestPersistence,
  credential,
  record,
  sealed,
  secretVersionId,
  workspaceId,
} from '../support/use-case-fixture.js';

export function registerTestsResendAfterDisclosureOneFixed(): void {
  it('tests Resend only after disclosure with one fixed message and stable provider key', async () => {
    const controller = new AbortController();
    const emailRecord = record({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: 'Transactional email',
    });
    const store = connectionTestPersistence({
      resolveConnectionTestSecret: vi.fn(() =>
        Promise.resolve({ connection: emailRecord, secretVersionId, sealed }),
      ),
      completeConnectionTest: vi.fn<
        ConnectionTestPersistence['completeConnectionTest']
      >((input) =>
        Promise.resolve({ connection: emailRecord, outcome: input.outcome }),
      ),
    });
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        type: 'resend_api_key',
        apiKey: 're_123456789_secret',
        fromEmail: 'Sender@Example.COM',
      }),
    );
    const sendNotification = vi.fn<ConnectionEmailClient['sendNotification']>(
      async (input) => {
        expect(input).toMatchObject({
          apiKey: 're_123456789_secret',
          fromEmail: 'Sender@example.com',
          toEmail: 'delivered@resend.dev',
          subject: 'Pertexo Resend connection test',
          text: 'This message verifies a Pertexo Resend sending connection.',
          timeoutMillis: 15_000,
          signal: controller.signal,
        });
        expect(input.idempotencyKey).toBe(
          'pertexo-connection-test-v1-36c369e31f137800ce05532683713337647e2ee5f72338fcb09f7fab95e1f5e6',
        );
        await input.beforeDispatch();
        return {
          kind: 'succeeded',
          emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
        };
      },
    );
    const useCase = new TestConnectionUseCase(store, authorization(), {
      encryption: {
        seal: vi.fn(),
        open: vi.fn(() => Promise.resolve(plaintext)),
      },
      httpClient: { execute: vi.fn() },
      applicationSecret: 'fixture-application-secret',
      telemetry: undefined,
      slackClient: undefined,
      emailClient: { sendNotification },
    });
    const command = {
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'test-email-stable',
    };

    await expect(
      useCase.execute({
        ...command,
        request: {
          providerKey: 'email',
          sideEffectDisclosureAccepted: true,
        },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ outcome: { ok: true, httpStatus: 200 } });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(store.markConnectionTestDispatched).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it('does not contact a provider when cancellation races decryption completion', async () => {
    const controller = new AbortController();
    const store = connectionTestPersistence();
    const plaintext = new TextEncoder().encode(JSON.stringify(credential));
    const execute = vi.fn();
    const encryption = {
      seal: vi.fn(),
      open: vi.fn(() => {
        controller.abort();
        return Promise.resolve(plaintext);
      }),
    };

    await expect(
      new TestConnectionUseCase(store, authorization(), {
        encryption: encryption,
        httpClient: {
          execute,
        },
        applicationSecret: 'fixture-application-secret',
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'test-canceled-after-decryption',
        request: { url: 'https://provider.example.test/health' },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(execute).not.toHaveBeenCalled();
    expect(store.markConnectionTestDispatched).not.toHaveBeenCalled();
    expect(store.completeConnectionTest).not.toHaveBeenCalled();
    expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    { providerKey: 'email' },
    { providerKey: 'email', sideEffectDisclosureAccepted: false },
  ])(
    'rejects email test disclosure %j before claim, secret open, or dispatch',
    async (request) => {
      const store = connectionTestPersistence();
      const open = vi.fn();
      const sendNotification = vi.fn();
      await expect(
        new TestConnectionUseCase(store, authorization(), {
          encryption: { seal: vi.fn(), open },
          httpClient: { execute: vi.fn() },
          applicationSecret: 'fixture-application-secret',
          telemetry: undefined,
          slackClient: undefined,
          emailClient: { sendNotification },
        }).execute({
          actor,
          routeWorkspaceId: workspaceId,
          connectionId,
          idempotencyKey: 'test-email-disclosure',
          request,
        }),
      ).rejects.toBeDefined();
      expect(store.startConnectionTest).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
    },
  );

  it('denies a viewer before claiming or decrypting a connection test', async () => {
    const store = connectionTestPersistence();
    const deniedAuthorization = {
      findAccess: vi.fn().mockResolvedValue({
        actorId,
        workspaceId,
        role: 'viewer' as const,
        membershipStatus: 'active' as const,
        workspaceStatus: 'active' as const,
      }),
    };
    const encryption = { seal: vi.fn(), open: vi.fn() };
    const httpClient = { execute: vi.fn() };

    await expect(
      new TestConnectionUseCase(store, deniedAuthorization, {
        encryption: encryption,
        httpClient: httpClient,
        applicationSecret: 'fixture-application-secret',
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'test-viewer',
        request: { url: 'https://provider.example.test/health' },
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(store.startConnectionTest).not.toHaveBeenCalled();
    expect(encryption.open).not.toHaveBeenCalled();
  });
}
