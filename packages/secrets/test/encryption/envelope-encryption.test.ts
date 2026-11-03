import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionEnvelopeEncryption,
  ConnectionSecretEncryptionError,
} from '../../src/server.js';
import { context, ContextBoundKeyProvider } from '../support/envelope-key.js';
describe('connection envelope encryption', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round trips bytes only with the exact authenticated identity context', async () => {
    const keyProvider = new ContextBoundKeyProvider();
    const encryption = new ConnectionEnvelopeEncryption(keyProvider);
    const identity = context();
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        headers: { Authorization: 'secret' },
      }),
    );

    const sealed = await encryption.seal(plaintext, identity);

    await expect(encryption.open(sealed, identity)).resolves.toEqual(plaintext);
    await expect(
      encryption.open(sealed, { ...identity, workspaceId: randomUUID() }),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
    await expect(
      encryption.open(
        { ...sealed, ciphertext: `${sealed.ciphertext}A` },
        identity,
      ),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
    expect(keyProvider.issuedPlaintextKeys).not.toHaveLength(0);
    for (const key of keyProvider.issuedPlaintextKeys)
      expect([...key]).toEqual(new Array<number>(32).fill(0));
  });

  it('fails with one safe error for malformed or oversized material', async () => {
    const encryption = new ConnectionEnvelopeEncryption(
      new ContextBoundKeyProvider(),
    );
    await expect(encryption.seal(new Uint8Array(), context())).rejects.toEqual(
      expect.objectContaining({
        name: 'ConnectionSecretEncryptionError',
        message: 'Connection secret encryption failed',
      }),
    );
    await expect(
      encryption.seal(new Uint8Array(65_537), context()),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
  });

  it('validates every encoded envelope component before requesting a data key', async () => {
    const decryptDataKey = vi.fn(() =>
      Promise.resolve(new Uint8Array(32).fill(7)),
    );
    const encryption = new ConnectionEnvelopeEncryption({
      generateDataKey: () =>
        Promise.resolve({
          plaintextKey: new Uint8Array(32).fill(7),
          encryptedDataKey: Uint8Array.of(1, 2, 3),
          keyReference: 'test-key',
        }),
      decryptDataKey,
    });
    const identity = context();
    const sealed = await encryption.seal(
      new TextEncoder().encode('connection secret'),
      identity,
    );

    for (const candidate of [
      { ...sealed, encryptedDataKey: '@' },
      { ...sealed, kmsKeyReference: '€'.repeat(683) },
      { ...sealed, nonce: '@' },
      { ...sealed, tag: '@' },
      { ...sealed, ciphertext: '@' },
    ])
      await expect(encryption.open(candidate, identity)).rejects.toBeInstanceOf(
        ConnectionSecretEncryptionError,
      );
    expect(decryptDataKey).not.toHaveBeenCalled();
  });

  it('rejects encoded ciphertext overflow before allocating its decoded bytes', async () => {
    const decryptDataKey = vi.fn(() =>
      Promise.resolve(new Uint8Array(32).fill(7)),
    );
    const encryption = new ConnectionEnvelopeEncryption({
      generateDataKey: vi.fn(),
      decryptDataKey,
    });
    const exactCiphertext = Buffer.alloc(65_536).toString('base64url');
    const oversizedCiphertext = Buffer.alloc(65_537).toString('base64url');
    const envelope = {
      kmsKeyReference: 'test-key',
      encryptedDataKey: Buffer.from([1]).toString('base64url'),
      nonce: Buffer.alloc(12).toString('base64url'),
      tag: Buffer.alloc(16).toString('base64url'),
      ciphertext: exactCiphertext,
    };

    await expect(encryption.open(envelope, context())).rejects.toBeInstanceOf(
      ConnectionSecretEncryptionError,
    );
    expect(decryptDataKey).toHaveBeenCalledOnce();
    decryptDataKey.mockClear();
    const from = vi.spyOn(Buffer, 'from');
    await expect(
      encryption.open(
        { ...envelope, ciphertext: oversizedCiphertext },
        context(),
      ),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
    expect(decryptDataKey).not.toHaveBeenCalled();
    expect(
      from.mock.calls.some(([value]) => value === oversizedCiphertext),
    ).toBe(false);
  });

  it('clears every decoded envelope component after authenticated open', async () => {
    const provider = new ContextBoundKeyProvider();
    const encryption = new ConnectionEnvelopeEncryption(provider);
    const identity = context();
    const plaintext = new TextEncoder().encode('decoded component ownership');
    const sealed = await encryption.seal(plaintext, identity);
    const expectedDecoded = [
      sealed.encryptedDataKey,
      sealed.nonce,
      sealed.tag,
      sealed.ciphertext,
    ].map((value) => new Uint8Array(Buffer.from(value, 'base64url')));
    // The original method is retained so the spy can observe and then perform
    // the real zeroing without recursively invoking itself.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalFill = Uint8Array.prototype.fill;
    const cleared: {
      before: Uint8Array;
      target: Uint8Array;
    }[] = [];
    vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
      this: Uint8Array,
      value: number,
      start?: number,
      end?: number,
    ) {
      cleared.push({ before: new Uint8Array(this), target: this });
      return originalFill.call(this, value, start, end);
    });

    const opened = await encryption.open(sealed, identity);
    expect(opened).toEqual(plaintext);
    for (const expected of expectedDecoded) {
      const ownership = cleared.find(
        ({ before }) =>
          before.byteLength === expected.byteLength &&
          before.every((byte, index) => byte === expected[index]),
      );
      expect(ownership).toBeDefined();
      expect(ownership?.target.every((byte) => byte === 0)).toBe(true);
    }
    expect(opened).toEqual(plaintext);
    opened.fill(0);
  });

  it('clears a returned data key when cancellation wins after KMS completion', async () => {
    const controller = new AbortController();
    const returnedKey = new Uint8Array(32).fill(7);
    const encryption = new ConnectionEnvelopeEncryption({
      generateDataKey: () =>
        Promise.resolve({
          plaintextKey: new Uint8Array(32).fill(7),
          encryptedDataKey: Uint8Array.of(1, 2, 3),
          keyReference: 'test-key',
        }),
      decryptDataKey: () => {
        controller.abort();
        return Promise.resolve(returnedKey);
      },
    });
    const identity = context();
    const sealed = await encryption.seal(
      new TextEncoder().encode('connection secret'),
      identity,
    );

    await expect(
      encryption.open(sealed, identity, controller.signal),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
    expect(returnedKey.every((byte) => byte === 0)).toBe(true);
  });

  it('clears native decipher plaintext temporaries on success and tag failure', async () => {
    const provider = new ContextBoundKeyProvider();
    const encryption = new ConnectionEnvelopeEncryption(provider);
    const identity = context();
    const plaintext = Buffer.from('native decipher temporary secret');
    const sealed = await encryption.seal(plaintext, identity);
    const snapshots: Buffer[] = [];
    const bufferPrototype = Buffer.prototype as unknown as {
      fill(value: unknown, start?: unknown, end?: unknown): Buffer;
    };
    vi.spyOn(bufferPrototype, 'fill').mockImplementation(function (
      this: Buffer,
      value: unknown,
      start?: unknown,
      end?: unknown,
    ) {
      if (
        typeof value !== 'number' ||
        (start !== undefined && typeof start !== 'number') ||
        (end !== undefined && typeof end !== 'number')
      )
        throw new TypeError('Unexpected Buffer.fill test invocation');
      snapshots.push(Buffer.from(this));
      Uint8Array.prototype.fill.call(this, value, start, end);
      return this;
    });

    const opened = await encryption.open(sealed, identity);
    expect(Buffer.from(opened).equals(plaintext)).toBe(true);
    const successfulPlaintextTemporaries = snapshots.filter((snapshot) =>
      snapshot.equals(plaintext),
    );
    expect(successfulPlaintextTemporaries.length).toBeGreaterThanOrEqual(2);
    for (const temporary of successfulPlaintextTemporaries)
      expect(temporary.byteLength).toBe(plaintext.byteLength);
    expect(Buffer.from(opened).equals(plaintext)).toBe(true);

    snapshots.length = 0;
    await expect(
      encryption.open(
        {
          ...sealed,
          tag: Buffer.alloc(16, 9).toString('base64url'),
        },
        identity,
      ),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
    expect(snapshots.some((snapshot) => snapshot.equals(plaintext))).toBe(true);
    expect(Buffer.from(opened).equals(plaintext)).toBe(true);
    opened.fill(0);
    plaintext.fill(0);
  });
});
