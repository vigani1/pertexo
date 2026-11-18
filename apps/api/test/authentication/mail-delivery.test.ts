import { describe, expect, it, vi } from 'vitest';

import {
  LocalAuthenticationMailSink,
  type LocalAuthenticationMailMessage,
  printLocalAuthenticationMail,
} from '../../src/authentication/mail/authentication-mail.js';

/**
 * Durable mail (sealing, lifetimes, notice text and the size refusal) runs
 * against PostgreSQL in better-auth-postgres.integration.test.ts. The local
 * development sink writes to the developer's terminal, which stays a fake.
 */
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
