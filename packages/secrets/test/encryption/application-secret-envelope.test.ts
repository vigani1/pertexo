import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createApplicationSecretEnvelope } from '../../src/encryption/application-secret-envelope.js';

describe('application secret envelope', () => {
  it('rejects duplicate versions instead of replacing key material', () => {
    const key = Buffer.alloc(32, 1).toString('base64');
    expect(() =>
      createApplicationSecretEnvelope({
        current: { version: '1', key },
        previous: [
          { version: '1', key: Buffer.alloc(32, 2).toString('base64') },
        ],
      }),
    ).toThrow('Application key versions must be unique');
    expect(() =>
      createApplicationSecretEnvelope({
        current: { version: '2', key },
        previous: [
          { version: '1', key },
          { version: '1', key },
        ],
      }),
    ).toThrow('Application key versions must be unique');
  });

  it('rejects malformed keys and bounded inputs', () => {
    expect(() =>
      createApplicationSecretEnvelope({
        current: {
          version: 'invalid',
          key: Buffer.alloc(31).toString('base64'),
        },
      }),
    ).toThrow('Application secret key must encode exactly 32 bytes');

    const envelope = createApplicationSecretEnvelope({
      current: {
        version: 'v1',
        key: Buffer.alloc(32, 1).toString('base64'),
      },
    });
    expect(() => envelope.seal('', 'attempt-1')).toThrow(
      'Application secret input is invalid',
    );
    expect(() => envelope.seal('secret', '')).toThrow(
      'Application secret input is invalid',
    );
  });

  it('opens only with matching associated data and supports prior keys', () => {
    const prior = createApplicationSecretEnvelope({
      current: {
        version: 'v1',
        key: Buffer.alloc(32, 1).toString('base64'),
      },
    });
    const sealed = prior.seal('sensitive invitation token', 'attempt-1');
    const rotated = createApplicationSecretEnvelope({
      current: {
        version: 'v2',
        key: Buffer.alloc(32, 2).toString('base64url'),
      },
      previous: [
        { version: 'v1', key: Buffer.alloc(32, 1).toString('base64') },
      ],
    });

    expect(rotated.open(sealed, 'attempt-1')).toBe(
      'sensitive invitation token',
    );
    expect(() => rotated.open(sealed, 'attempt-2')).toThrow();
    expect(() =>
      rotated.open({ ...sealed, keyVersion: 'unknown' }, 'attempt-1'),
    ).toThrow('Application secret key is unavailable');
  });
});

describe('authenticated envelope format', () => {
  it.each([
    ['tag', 4],
    ['tag', 12],
    ['tag', 15],
    ['tag', 17],
    ['nonce', 0],
    ['nonce', 8],
    ['nonce', 11],
    ['nonce', 13],
    ['nonce', 16],
  ] as const)(
    'refuses a %s of %s bytes while retaining valid envelopes',
    (field, bytes) => {
      const envelope = createApplicationSecretEnvelope({
        current: { version: 'v1', key: Buffer.alloc(32, 9).toString('base64') },
      });
      const sealed = envelope.seal('private stored payload', 'purpose/account');
      const original = Buffer.from(sealed[field], 'base64url');
      const changed = Buffer.concat([original, Buffer.alloc(bytes)])
        .subarray(0, bytes)
        .toString('base64url');
      expect(() =>
        envelope.open({ ...sealed, [field]: changed }, 'purpose/account'),
      ).toThrow();
      expect(envelope.open(sealed, 'purpose/account')).toBe(
        'private stored payload',
      );
    },
  );
  it.each([8, 11, 13, 16])(
    'rejects an otherwise authenticated envelope with a %s-byte nonce',
    (bytes) => {
      const key = Buffer.alloc(32, 9),
        nonce = Buffer.alloc(bytes, 7);
      const cipher = createCipheriv('aes-256-gcm', key, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(Buffer.from('purpose/account'));
      const ciphertext = Buffer.concat([
        cipher.update('private stored payload'),
        cipher.final(),
      ]);
      const envelope = createApplicationSecretEnvelope({
        current: { version: 'v1', key: key.toString('base64') },
      });
      expect(() =>
        envelope.open(
          {
            keyVersion: 'v1',
            nonce: nonce.toString('base64url'),
            tag: cipher.getAuthTag().toString('base64url'),
            ciphertext: ciphertext.toString('base64url'),
          },
          'purpose/account',
        ),
      ).toThrow();
    },
  );
});
