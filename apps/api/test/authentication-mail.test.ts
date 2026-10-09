import type { AuthenticationMailEnqueueStore } from '@pertexo/database/identity';
import { describe, expect, it, vi } from 'vitest';

import {
  DurableAuthenticationMail,
  LocalAuthenticationMailSink,
  authenticationMailAssociatedData,
  printLocalAuthenticationMail,
} from '../src/identity-infrastructure/authentication-mail.js';

describe('local authentication mail', () => {
  it('keeps every message and shows each one to its observer', async () => {
    const observe = vi.fn();
    const mail = new LocalAuthenticationMailSink(observe);

    await mail.sendVerification({
      recipient: 'ada@example.test',
      displayName: 'Ada',
      url: 'http://127.0.0.1:5173/verify-email?token=verify',
    });
    await mail.sendEmailChangeConfirmation({
      recipient: 'ada@example.test',
      displayName: 'Ada',
      newEmail: 'ada@new.example.test',
      url: 'http://127.0.0.1:5173/verify-email?token=change',
    });

    const kept = mail.readForTesting('ada@example.test');
    expect(kept.map((message) => message.purpose)).toEqual([
      'verification',
      'email_change_confirmation',
    ]);
    expect(kept[1]).toMatchObject({ newEmail: 'ada@new.example.test' });
    expect(observe.mock.calls.map(([message]: unknown[]) => message)).toEqual(
      kept,
    );
  });

  it('prints the link on its own line for the developer', () => {
    const write = vi.fn();

    printLocalAuthenticationMail(
      {
        purpose: 'password_reset',
        recipient: 'ada@example.test',
        displayName: 'Ada',
        url: 'http://127.0.0.1:5173/reset-password?token=reset',
        createdAt: new Date('2026-09-29T00:00:00.000Z'),
      },
      { write },
    );

    expect(write).toHaveBeenCalledWith(
      '\nLocal authentication mail (development only): password_reset for ada@example.test\nhttp://127.0.0.1:5173/reset-password?token=reset\n\n',
    );
  });
});

describe('durable authentication mail', () => {
  it('seals recipient and immutable request bytes before durable enqueue', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const store = {
      enqueue,
      close: vi.fn().mockResolvedValue(undefined),
    } satisfies AuthenticationMailEnqueueStore;
    const seal = vi.fn().mockReturnValue({
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      tag: 'tag',
      keyVersion: 'v1',
    });
    const now = new Date('2026-09-23T00:00:00.000Z');
    const mail = new DurableAuthenticationMail(
      store,
      { seal },
      'security@example.test',
      () => now,
    );

    await mail.sendPasswordReset({
      recipient: 'ada@example.test',
      displayName: 'Ada',
      url: 'https://app.example.test/reset-password?token=secret',
    });

    const command = enqueue.mock.calls[0]?.[0] as {
      id: string;
      purpose: string;
      expiresAt: Date;
    };
    expect(command.purpose).toBe('password_reset');
    expect(command.expiresAt).toEqual(new Date('2026-09-23T01:00:00.000Z'));
    expect(seal).toHaveBeenCalledWith(
      expect.stringContaining('ada@example.test'),
      authenticationMailAssociatedData(
        command.purpose,
        command.id,
        command.expiresAt,
      ),
    );
    expect(JSON.stringify(command)).not.toContain('ada@example.test');
    expect(JSON.stringify(command)).not.toContain('token=secret');
  });

  it('bounds verification delivery by the one-hour Better Auth link lifetime', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const now = new Date('2026-09-23T00:00:00.000Z');
    const mail = new DurableAuthenticationMail(
      { enqueue, close: vi.fn().mockResolvedValue(undefined) },
      {
        seal: vi.fn().mockReturnValue({
          ciphertext: 'ciphertext',
          nonce: 'nonce',
          tag: 'tag',
          keyVersion: 'v1',
        }),
      },
      'security@example.test',
      () => now,
    );
    await mail.sendVerification({
      recipient: 'ada@example.test',
      displayName: 'Ada',
      url: 'https://app.example.test/verify-email?token=secret',
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'verification',
        expiresAt: new Date('2026-09-23T01:00:00.000Z'),
      }),
    );
  });
});
