import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { OwnedEmailProofs } from '../../src/authentication/mail/email-proofs.js';
import { LocalAuthenticationMailSink } from '../../src/authentication/mail/delivery.js';

it.each([
  { outcome: 'initial_verification', expected: 'verified=true' },
  { outcome: 'change_old', expected: 'emailChangePending=true' },
  { outcome: 'change_new', expected: 'emailChanged=true' },
  { outcome: 'invalid', expected: 'error=verification_invalid' },
  { outcome: 'sign_up_closed', expected: 'error=sign_up_closed' },
] as const)(
  'lands $outcome without exposing a proof',
  async ({ outcome, expected }) => {
    const pool = new Pool();
    const proofs = new OwnedEmailProofs(
      pool,
      new LocalAuthenticationMailSink(),
      'https://pertexo.test',
      'open',
    );
    const consume = vi.spyOn(proofs, 'consume').mockResolvedValue(outcome);
    try {
      const result = await proofs.handle(
        new Request(
          'https://pertexo.test/v1/auth/verify-email?token=private-proof&returnTo=%2Faccount%2Fsecurity',
        ),
      );
      expect(result?.status).toBe(302);
      const location = result?.headers.get('location');
      expect(location).toContain(expected);
      expect(location).not.toContain('private-proof');
      expect(consume).toHaveBeenCalledExactlyOnceWith('private-proof');
      expect(location?.includes('returnTo=')).toBe(
        outcome === 'initial_verification',
      );
      consume.mockClear();
      const refused = await proofs.handle(
        new Request(
          'https://pertexo.test/v1/auth/verify-email?token=private-proof',
          { method: 'POST' },
        ),
      );
      expect(refused?.headers.get('location')).toBe(
        'https://pertexo.test/login?error=verification_invalid',
      );
      expect(consume).not.toHaveBeenCalled();
    } finally {
      consume.mockRestore();
      await pool.end();
    }
  },
);
