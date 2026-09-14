import { randomBytes, randomUUID } from 'node:crypto';

import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AwsKmsEnvelopeKeyProvider,
  ConnectionEnvelopeEncryption,
  ConnectionSecretEncryptionError,
  type ConnectionSecretContext,
  type EnvelopeKeyProvider,
  type KmsCommand,
} from '../src/server.js';

const context = (): ConnectionSecretContext => ({
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  secretVersionId: randomUUID(),
});

class ContextBoundKeyProvider implements EnvelopeKeyProvider {
  private readonly key = randomBytes(32);
  private expectedContext = '';
  public readonly issuedPlaintextKeys: Uint8Array[] = [];

  public generateDataKey(input: ConnectionSecretContext) {
    this.expectedContext = JSON.stringify(input);
    const plaintextKey = new Uint8Array(this.key);
    this.issuedPlaintextKeys.push(plaintextKey);
    return Promise.resolve({
      plaintextKey,
      encryptedDataKey: new TextEncoder().encode(this.expectedContext),
      keyReference: 'test-key',
    });
  }

  public decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    input: ConnectionSecretContext,
  ) {
    if (
      keyReference !== 'test-key' ||
      new TextDecoder().decode(encryptedDataKey) !== JSON.stringify(input) ||
      JSON.stringify(input) !== this.expectedContext
    )
      throw new Error('KMS encryption context mismatch');
    const plaintextKey = new Uint8Array(this.key);
    this.issuedPlaintextKeys.push(plaintextKey);
    return Promise.resolve(plaintextKey);
  }
}

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
        schemaVersion: 1,
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
      schemaVersion: 1 as const,
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

describe('AWS KMS envelope-key adapter', () => {
  it('binds every KMS operation to the exact connection encryption context', async () => {
    const commands: KmsCommand[] = [];
    const client = {
      send: (command: KmsCommand): Promise<unknown> => {
        commands.push(command);
        return Promise.resolve(
          command instanceof GenerateDataKeyCommand
            ? {
                Plaintext: randomBytes(32),
                CiphertextBlob: randomBytes(96),
                KeyId: 'arn:aws:kms:eu-central-1:123456789012:key/example',
              }
            : { Plaintext: randomBytes(32) },
        );
      },
    };
    const provider = new AwsKmsEnvelopeKeyProvider(client, 'alias/pertexo');
    const identity = context();

    const generated = await provider.generateDataKey(identity);
    await provider.decryptDataKey(
      generated.encryptedDataKey,
      generated.keyReference,
      identity,
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect(commands[1]).toBeInstanceOf(DecryptCommand);
    for (const command of commands) {
      expect(command.input.EncryptionContext).toEqual({
        purpose: 'pertexo-connection-secret',
        schemaVersion: '1',
        workspaceId: identity.workspaceId,
        connectionId: identity.connectionId,
        secretVersionId: identity.secretVersionId,
      });
    }
    expect(commands[0]?.input).toMatchObject({
      KeyId: 'alias/pertexo',
      KeySpec: 'AES_256',
    });
    expect(commands[1]?.input).toMatchObject({
      KeyId: generated.keyReference,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
    });
  });

  it('does not expose KMS failure details', async () => {
    const provider = new AwsKmsEnvelopeKeyProvider(
      {
        send: () => Promise.reject(new Error('sensitive upstream detail')),
      },
      'alias/pertexo',
    );

    const failure = await provider
      .generateDataKey(context())
      .catch((error: unknown) => error);
    expect(failure).toEqual(
      expect.objectContaining({
        name: 'ConnectionSecretEncryptionError',
        message: 'Connection secret encryption failed',
      }),
    );
    expect(failure).not.toHaveProperty('cause');
  });

  it.each([
    ['null response', null],
    ['primitive response', 'not-a-record'],
    ['missing plaintext', { CiphertextBlob: randomBytes(96) }],
    [
      'short plaintext',
      { Plaintext: randomBytes(31), CiphertextBlob: randomBytes(96) },
    ],
    ['missing ciphertext', { Plaintext: randomBytes(32) }],
    [
      'empty ciphertext',
      { Plaintext: randomBytes(32), CiphertextBlob: new Uint8Array() },
    ],
    [
      'invalid returned key reference',
      {
        Plaintext: randomBytes(32),
        CiphertextBlob: randomBytes(96),
        KeyId: '',
      },
    ],
  ])(
    'fails closed for a malformed GenerateDataKey %s',
    async (_name, reply) => {
      const provider = new AwsKmsEnvelopeKeyProvider(
        { send: () => Promise.resolve(reply) },
        'alias/pertexo',
      );

      await expect(provider.generateDataKey(context())).rejects.toEqual(
        expect.objectContaining({
          name: 'ConnectionSecretEncryptionError',
          message: 'Connection secret encryption failed',
        }),
      );
    },
  );

  it.each([
    ['null response', null],
    ['primitive response', 17],
    ['missing plaintext', {}],
    ['short plaintext', { Plaintext: randomBytes(31) }],
  ])('fails closed for a malformed Decrypt %s', async (_name, reply) => {
    const provider = new AwsKmsEnvelopeKeyProvider(
      { send: () => Promise.resolve(reply) },
      'alias/pertexo',
    );

    await expect(
      provider.decryptDataKey(randomBytes(96), 'alias/pertexo', context()),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
  });

  it('uses the configured key reference when KMS omits KeyId', async () => {
    const provider = new AwsKmsEnvelopeKeyProvider(
      {
        send: () =>
          Promise.resolve({
            Plaintext: randomBytes(32),
            CiphertextBlob: randomBytes(96),
          }),
      },
      'alias/pertexo',
    );

    await expect(provider.generateDataKey(context())).resolves.toMatchObject({
      keyReference: 'alias/pertexo',
    });
  });

  it('bounds key references by their UTF-8 byte length', async () => {
    const validMultibyteReference = '€'.repeat(682);
    const provider = new AwsKmsEnvelopeKeyProvider(
      {
        send: () =>
          Promise.resolve({
            Plaintext: randomBytes(32),
            CiphertextBlob: randomBytes(96),
          }),
      },
      validMultibyteReference,
    );

    await expect(provider.generateDataKey(context())).resolves.toMatchObject({
      keyReference: validMultibyteReference,
    });
    expect(
      () =>
        new AwsKmsEnvelopeKeyProvider(
          { send: () => Promise.resolve({}) },
          '€'.repeat(683),
        ),
    ).toThrow('KMS key reference is invalid');
  });

  it('omits KMS request options when no abort signal is supplied', async () => {
    const options: unknown[] = [];
    const provider = new AwsKmsEnvelopeKeyProvider(
      {
        send: (command: KmsCommand, requestOptions?: unknown) => {
          options.push(requestOptions);
          return Promise.resolve(
            command instanceof GenerateDataKeyCommand
              ? {
                  Plaintext: randomBytes(32),
                  CiphertextBlob: randomBytes(96),
                }
              : { Plaintext: randomBytes(32) },
          );
        },
      },
      'alias/pertexo',
    );
    const identity = context();
    const generated = await provider.generateDataKey(identity);
    await provider.decryptDataKey(
      generated.encryptedDataKey,
      generated.keyReference,
      identity,
    );

    expect(options).toEqual([undefined, undefined]);
  });

  it('forwards abort to KMS and zeroes plaintext returned after abort', async () => {
    const controller = new AbortController();
    const latePlaintext = randomBytes(32);
    let resolveKms: ((value: unknown) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const provider = new AwsKmsEnvelopeKeyProvider(
      {
        send: (
          _command: KmsCommand,
          options?: Readonly<{ abortSignal?: AbortSignal }>,
        ) => {
          observedSignal = options?.abortSignal;
          return new Promise<unknown>((resolve) => {
            resolveKms = resolve;
          });
        },
      },
      'alias/pertexo',
    );

    const pending = provider.decryptDataKey(
      randomBytes(96),
      'alias/pertexo',
      context(),
      controller.signal,
    );
    await Promise.resolve();
    expect(observedSignal).toBe(controller.signal);
    controller.abort();
    resolveKms?.({ Plaintext: latePlaintext });

    await expect(pending).rejects.toBeInstanceOf(
      ConnectionSecretEncryptionError,
    );
    expect([...latePlaintext]).toEqual(new Array<number>(32).fill(0));
  });
});
