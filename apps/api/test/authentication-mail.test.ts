import type { AuthenticationMailEnqueueStore } from '@pertexo/database/api';
import { describe, expect, it, vi } from 'vitest';

import {
  DurableAuthenticationMail,
  authenticationMailAssociatedData,
} from '../src/identity-infrastructure/authentication-mail.js';

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
