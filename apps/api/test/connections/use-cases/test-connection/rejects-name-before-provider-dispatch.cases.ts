import { ConnectionSecretEncryptionError } from '@pertexo/integrations/server';
import { expect, it, vi } from 'vitest';
import { TestConnectionUseCase } from '../../../../src/connections/use-cases/test-connection.js';
import type {
  ConnectionEmailClient,
  ConnectionSlackClient,
} from '../../../../src/connections/ports.js';

import { activeAccess, persistence, command } from './fixture.js';

export function registerRejectsNameBeforeProviderDispatch(): void {
  it.each([
    {
      name: 'invalid UTF-8',
      request: { url: 'https://provider.example.test/health' },
      bytes: () => Uint8Array.from([0xff]),
      clients: 'http' as const,
    },
    {
      name: 'malformed JSON',
      request: { url: 'https://provider.example.test/health' },
      bytes: () => new TextEncoder().encode('{'),
      clients: 'http' as const,
    },
    {
      name: 'invalid credential fields',
      request: { providerKey: 'slack' },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            type: 'slack_bot_token',
            botToken: 'short',
          }),
        ),
      clients: 'slack' as const,
    },
    {
      name: 'HTTP credential on email route',
      request: {
        providerKey: 'email',
        sideEffectDisclosureAccepted: true,
      },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            type: 'http_headers',
            headers: { authorization: 'Bearer secret' },
          }),
        ),
      clients: 'email' as const,
    },
    {
      name: 'email credential without email client',
      request: {
        providerKey: 'email',
        sideEffectDisclosureAccepted: true,
      },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            type: 'resend_api_key',
            apiKey: 're_123456789_secret',
            fromEmail: 'sender@example.com',
          }),
        ),
      clients: 'none' as const,
    },
    {
      name: 'HTTP credential on Slack route',
      request: { providerKey: 'slack' },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            type: 'http_headers',
            headers: { authorization: 'Bearer secret' },
          }),
        ),
      clients: 'slack' as const,
    },
    {
      name: 'Slack credential without Slack client',
      request: { providerKey: 'slack' },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            type: 'slack_bot_token',
            botToken: 'xoxb-123456789-secret',
          }),
        ),
      clients: 'none' as const,
    },
    {
      name: 'Slack credential on HTTP route',
      request: { url: 'https://provider.example.test/health' },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            type: 'slack_bot_token',
            botToken: 'xoxb-123456789-secret',
          }),
        ),
      clients: 'http' as const,
    },
  ])(
    'rejects $name before provider dispatch',
    async ({ request, bytes, clients }) => {
      const plaintext = bytes();
      const execute = vi.fn();
      const authTest = vi.fn();
      const sendNotification = vi.fn();
      const store = persistence();
      const slackClient: Pick<ConnectionSlackClient, 'authTest'> | undefined =
        clients === 'slack' ? { authTest } : undefined;
      const emailClient: ConnectionEmailClient | undefined =
        clients === 'email' ? { sendNotification } : undefined;

      await expect(
        new TestConnectionUseCase(
          store,
          { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
          {
            encryption: {
              seal: vi.fn(),
              open: vi.fn(() => Promise.resolve(plaintext)),
            },
            httpClient: { execute },
            applicationSecret: 'fixture-application-secret',
            telemetry: undefined,
            slackClient: slackClient,
            emailClient: emailClient,
          },
        ).execute(command(request)),
      ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
      expect(execute).not.toHaveBeenCalled();
      expect(authTest).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
      expect(store.completeConnectionTest).not.toHaveBeenCalled();
      expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    },
  );
}
