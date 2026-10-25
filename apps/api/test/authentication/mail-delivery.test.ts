import { authenticationMailAssociatedData } from '@pertexo/database/platform';
import type { SystemMailEnqueueStore } from '@pertexo/database/platform';
import { describe, expect, it, vi } from 'vitest';

import {
  DurableAuthenticationMail,
  LocalAuthenticationMailSink,
  type LocalAuthenticationMailMessage,
  printLocalAuthenticationMail,
} from '../../src/authentication/mail/delivery.js';

describe('local authentication mail', () => {
  it('shows every message to its observer', async () => {
    const observe = vi.fn<(message: LocalAuthenticationMailMessage) => void>();
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

    const kept = observe.mock.calls.map(([message]) => message);
    expect(kept.map((message) => message.purpose)).toEqual([
      'verification',
      'email_change_confirmation',
    ]);
    expect(kept[1]).toMatchObject({ newEmail: 'ada@new.example.test' });
    expect(observe).toHaveBeenCalledTimes(2);
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
  it('rejects an oversized sealed envelope at the producer before enqueue', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const mail = new DurableAuthenticationMail(
      { enqueue, close: vi.fn().mockResolvedValue(undefined) },
      {
        seal: () => ({
          ciphertext: 'x'.repeat(32769),
          nonce: 'nonce',
          tag: 'tag',
          keyVersion: 'v1',
        }),
      },
      'security@example.test',
    );
    await expect(
      mail.sendPasswordReset({
        recipient: 'ada@example.test',
        displayName: 'Ada',
        url: 'https://app.example.test/reset?token=reset',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('seals recipient and immutable request bytes before durable enqueue', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const store = {
      enqueue,
      close: vi.fn().mockResolvedValue(undefined),
    } satisfies SystemMailEnqueueStore;
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

for (const purpose of [
  'two_factor_disabled',
  'recovery_code_sign_in',
] as const) {
  it(`seals the ${purpose} security notice without codes or an ignore-this-message footer`, async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const seal = vi.fn().mockReturnValue({
      ciphertext: 'sealed',
      nonce: 'nonce',
      tag: 'tag',
      keyVersion: 'v1',
    });
    const now = new Date('2026-10-20T00:00:00Z');
    const mail = new DurableAuthenticationMail(
      { enqueue, close: vi.fn().mockResolvedValue(undefined) },
      { seal },
      'security@example.test',
      () => now,
    );
    await mail.sendSecurityNotice({
      purpose,
      recipient: 'ada@example.test',
      displayName: 'Ada',
      url: 'https://app.example.test/account/security',
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose,
        expiresAt: new Date('2026-10-21T00:00:00Z'),
      }),
    );
    const text = String(seal.mock.calls[0]?.[0]);
    expect(text).toContain('contact your Pertexo operator immediately');
    expect(text).not.toContain('ignore this message');
    expect(text).not.toContain('backupCodes');
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain(
      'ada@example.test',
    );
  });
}
