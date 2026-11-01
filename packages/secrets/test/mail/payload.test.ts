import { createDecipheriv } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { authenticationMailAssociatedData } from '../../src/mail/payload.js';

/**
 * Sealed by the envelope and associated-data code at 8aa533c1c~1, the commit
 * before these moved to `secrets`, and pasted here. Don't regenerate: a real
 * queue holds rows like this one, and they must still open.
 */
const MAIL_ID = 'a5d1c1a0-6a0e-4c3b-9a55-0f0e6f4c1d21';
const EXPIRES_AT = new Date('2099-01-01T00:00:00.000Z');
const HISTORICAL_ASSOCIATED_DATA = `pertexo/authentication-mail/password_reset/${MAIL_ID}/2099-01-01T00:00:00.000Z`;
const SEALED = {
  ciphertext:
    '-pjbSpslS87ouU1Eaa1JOqRZHdHPh6PTNnXBYg2EAYTw_52p_hKw5-J4-FHq91alPWy-NJPEubr34atoromQ4EFHGXIstfUmbS3Qgu9d0Lp_MJKAUTYXw27E-gUTV-luEApuL5qDg82iQkNvzO6qilacdEqL2XZ8t2MRPyPf9zpHyaBjUVDiPw',
  nonce: 'rWpqoaRlVC2Ijs1k',
  tag: 'rp_JP8Xv336vAiFJt89vkg',
};
const KEY = Buffer.alloc(32, 7);

function open(associatedData: string): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    KEY,
    Buffer.from(SEALED.nonce, 'base64url'),
  );
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(Buffer.from(SEALED.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(SEALED.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

describe('system mail associated data', () => {
  it('reads exactly as it did before the move', () => {
    expect(
      authenticationMailAssociatedData('password_reset', MAIL_ID, EXPIRES_AT),
    ).toBe(HISTORICAL_ASSOCIATED_DATA);
    expect(
      authenticationMailAssociatedData('verification', MAIL_ID, EXPIRES_AT),
    ).toBe(
      `pertexo/authentication-mail/verification/${MAIL_ID}/2099-01-01T00:00:00.000Z`,
    );
  });

  it('opens mail sealed before the move', () => {
    const message = JSON.parse(
      open(
        authenticationMailAssociatedData('password_reset', MAIL_ID, EXPIRES_AT),
      ),
    ) as unknown;

    expect(message).toMatchObject({
      toEmail: 'recipient@example.test',
      text: 'Sealed before the move',
    });
  });

  it.each([
    [
      'another prefix',
      `pertexo/system-mail/password_reset/${MAIL_ID}/2099-01-01T00:00:00.000Z`,
    ],
    [
      'another purpose',
      `pertexo/authentication-mail/verification/${MAIL_ID}/2099-01-01T00:00:00.000Z`,
    ],
    [
      'another message',
      `pertexo/authentication-mail/password_reset/${MAIL_ID.replace('a', 'b')}/2099-01-01T00:00:00.000Z`,
    ],
    [
      'another time format',
      `pertexo/authentication-mail/password_reset/${MAIL_ID}/2099-01-01T00:00:00Z`,
    ],
  ])('refuses it under %s', (_name, changed) => {
    expect(() => open(changed)).toThrow();
  });
});
