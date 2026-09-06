import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  Aes256GcmOidcSecretEncryption,
  OidcSecretEncryptionError,
  createOidcSecretEncryptionAdapter,
} from '../../src/identity-infrastructure/oidc-secret-encryption.js';

const currentKey = randomBytes(32).toString('base64');
const previousKey = randomBytes(32).toString('base64');
const associatedData = 'pertexo/oidc-login/state-digest/code_verifier';

function expectSealingError(operation: () => unknown): void {
  let failure: unknown;
  try {
    operation();
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(OidcSecretEncryptionError);
  expect(String(failure)).not.toContain('verifier plaintext');
  expect(String(failure)).not.toContain(currentKey);
  expect(String(failure)).not.toContain(previousKey);
}

describe('OIDC AES-256-GCM secret encryption', () => {
  it('round-trips with base64url sealed fields and the current key version', () => {
    const adapter = createOidcSecretEncryptionAdapter({
      current: { version: 'v2', key: currentKey },
    });
    const sealed = adapter.seal('verifier plaintext', associatedData);

    expect(sealed.keyVersion).toBe('v2');
    expect(sealed.ciphertext).not.toContain('verifier plaintext');
    expect(sealed.nonce).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(sealed.tag).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(adapter.open(sealed, associatedData)).toBe('verifier plaintext');
  });

  it('uses a fresh random nonce for each seal', () => {
    const adapter = new Aes256GcmOidcSecretEncryption({
      current: { version: 'v1', key: currentKey },
    });
    const first = adapter.seal('same plaintext', associatedData);
    const second = adapter.seal('same plaintext', associatedData);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('fails closed for wrong associated data and tampered fields', () => {
    const adapter = new Aes256GcmOidcSecretEncryption({
      current: { version: 'v1', key: currentKey },
    });
    const sealed = adapter.seal('verifier plaintext', associatedData);

    expectSealingError(() => adapter.open(sealed, 'different-associated-data'));
    expectSealingError(() =>
      adapter.open(
        { ...sealed, ciphertext: `${sealed.ciphertext}tampered` },
        associatedData,
      ),
    );
    expectSealingError(() =>
      adapter.open(
        {
          ...sealed,
          tag: `${sealed.tag.startsWith('A') ? 'B' : 'A'}${sealed.tag.slice(1)}`,
        },
        associatedData,
      ),
    );
    expectSealingError(() =>
      adapter.open({ ...sealed, keyVersion: 'unknown' }, associatedData),
    );
  });

  it('reads previous key versions while always writing with the current key', () => {
    const oldAdapter = new Aes256GcmOidcSecretEncryption({
      current: { version: 'v1', key: previousKey },
    });
    const rotatedAdapter = new Aes256GcmOidcSecretEncryption({
      current: { version: 'v2', key: currentKey },
      previous: [{ version: 'v1', key: previousKey }],
    });
    const oldSealed = oldAdapter.seal('rotated verifier', associatedData);

    expect(rotatedAdapter.open(oldSealed, associatedData)).toBe(
      'rotated verifier',
    );
    expect(rotatedAdapter.seal('new verifier', associatedData).keyVersion).toBe(
      'v2',
    );
  });

  it('rejects malformed key configuration without exposing key material', () => {
    for (const config of [
      { current: { version: 'v1', key: randomBytes(31).toString('base64') } },
      { current: { version: 'v1', key: 'not-base64' } },
      {
        current: { version: 'v1', key: currentKey },
        previous: [{ version: 'v1', key: previousKey }],
      },
      { current: { version: 'bad version', key: currentKey } },
    ]) {
      expectSealingError(() => new Aes256GcmOidcSecretEncryption(config));
    }
  });

  it('rejects invalid plaintext and associated-data bounds', () => {
    const adapter = new Aes256GcmOidcSecretEncryption({
      current: { version: 'v1', key: currentKey },
    });
    expectSealingError(() => adapter.seal('', associatedData));
    expectSealingError(() => adapter.seal('verifier plaintext', ''));
    expectSealingError(() => adapter.seal('x'.repeat(16_385), associatedData));
    expectSealingError(() =>
      adapter.seal('verifier plaintext', 'x'.repeat(513)),
    );
  });
});
