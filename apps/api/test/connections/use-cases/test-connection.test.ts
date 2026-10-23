import { describe, expect, it, vi } from 'vitest';
import { TestConnectionUseCase } from '../../../src/connections/use-cases/test-connection.js';
import type {
  ConnectionEmailClient,
  ConnectionSlackClient,
} from '../../../src/connections/ports.js';

import {
  workspaceId,
  connectionId,
  actor,
  record,
  activeAccess,
  persistence,
} from './test-connection/fixture.js';
import { registerRejectsOverByteUnicodeURLBefore } from './test-connection/rejects-over-byte-unicode-urlbefore.cases.js';
import { registerRejectsNameBeforeProviderDispatch } from './test-connection/rejects-name-before-provider-dispatch.cases.js';
import { registerPersistsExactHTTPStatusIOutcome } from './test-connection/persists-exact-httpstatus-ioutcome.cases.js';
import { registerPersistsExactSlackSOutcome } from './test-connection/persists-exact-slack-soutcome.cases.js';
import { registerPersistsExactEmailSOutcome } from './test-connection/persists-exact-email-soutcome.cases.js';
describe('connection testing security and cleanup regressions', () => {
  registerRejectsOverByteUnicodeURLBefore();

  registerRejectsNameBeforeProviderDispatch();
});
describe('connection provider outcome projection', () => {
  registerPersistsExactHTTPStatusIOutcome();

  registerPersistsExactSlackSOutcome();

  registerPersistsExactEmailSOutcome();
});
describe('alert destination tests', () => {
  const destination = {
    id: '55555555-5555-4555-8555-555555555555',
    workspaceId,
    kind: 'slack' as const,
    status: 'enabled' as const,
    currentVersion: 2,
    config: { kind: 'slack' as const, connectionId, channelId: 'C12345' },
    createdAt: '2026-08-22T12:00:00.000Z',
    updatedAt: '2026-08-22T12:00:00.000Z',
  };
  const input = {
    actor,
    routeWorkspaceId: workspaceId,
    idempotencyKey: 'destination-test',
  };

  it('posts to the reviewed Slack channel after recording dispatch, rather than auth.test', async () => {
    const store = persistence();
    const authTest = vi.fn();
    const sendMessage = vi.fn<
      NonNullable<ConnectionSlackClient['sendMessage']>
    >(async (request) => {
      await request.beforeDispatch();
      expect(store.markConnectionTestDispatched).toHaveBeenCalled();
      return {
        kind: 'succeeded',
        channelId: request.channelId,
        messageTs: '1.0',
      };
    });
    const useCase = new TestConnectionUseCase(
      store,
      { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
      {
        encryption: {
          seal: vi.fn(),
          open: vi.fn().mockImplementation(() =>
            Promise.resolve(
              Buffer.from(
                JSON.stringify({
                  type: 'slack_bot_token',
                  botToken: 'xoxb-local-test',
                }),
              ),
            ),
          ),
        },
        httpClient: { execute: vi.fn() },
        applicationSecret: 'fixture-application-secret',
        telemetry: undefined,
        slackClient: { authTest, sendMessage },
      },
    );
    expect(
      (await useCase.executeDestination(input, destination)).outcome.ok,
    ).toBe(true);
    expect(authTest).not.toHaveBeenCalled();
    const message = sendMessage.mock.calls[0]?.[0];
    expect(message?.channelId).toBe('C12345');
    expect(message?.text).toContain('No workflow failed');
    const firstHash = vi.mocked(store.startConnectionTest).mock.calls[0]?.[0]
      .requestHash;
    await useCase.executeDestination(input, {
      ...destination,
      currentVersion: 3,
    });
    expect(
      vi.mocked(store.startConnectionTest).mock.calls[1]?.[0].requestHash,
    ).not.toBe(firstHash);
  });

  it('sends an email to the destination address with stable provider idempotency', async () => {
    const store = persistence();
    const sendNotification = vi.fn<ConnectionEmailClient['sendNotification']>(
      async (request) => {
        await request.beforeDispatch();
        return { kind: 'succeeded', emailId: 'test-message' };
      },
    );
    const useCase = new TestConnectionUseCase(
      store,
      { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
      {
        encryption: {
          seal: vi.fn(),
          open: vi.fn().mockResolvedValue(
            Buffer.from(
              JSON.stringify({
                type: 'resend_api_key',
                apiKey: 're_local',
                fromEmail: 'alerts@example.test',
              }),
            ),
          ),
        },
        httpClient: { execute: vi.fn() },
        applicationSecret: 'fixture-application-secret',
        telemetry: undefined,
        slackClient: undefined,
        emailClient: { sendNotification },
      },
    );
    await useCase.executeDestination(input, {
      ...destination,
      kind: 'email',
      config: {
        kind: 'email',
        connectionId,
        toEmail: 'destination@example.test',
      },
    });
    const notification = sendNotification.mock.calls[0]?.[0];
    expect(notification?.toEmail).toBe('destination@example.test');
    expect(notification?.subject).toBe('Pertexo alert destination test');
    expect(notification?.idempotencyKey).toBeTypeOf('string');
  });

  it('replays without decrypting or sending another message', async () => {
    const store = persistence({
      startConnectionTest: vi.fn().mockResolvedValue({
        kind: 'replay',
        result: {
          connection: record(),
          outcome: { ok: true, httpStatus: 200 },
        },
      }),
    });
    const open = vi.fn();
    const sendMessage = vi.fn();
    const useCase = new TestConnectionUseCase(
      store,
      { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
      {
        encryption: { seal: vi.fn(), open },
        httpClient: { execute: vi.fn() },
        applicationSecret: 'fixture-application-secret',
        telemetry: undefined,
        slackClient: { authTest: vi.fn(), sendMessage },
      },
    );
    expect(
      (await useCase.executeDestination(input, destination)).outcome.ok,
    ).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
