import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type {
  OidcSecretEncryptionAdapter,
  SealedOidcSecret,
} from '@pertexo/database/api';

const AES_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const MAX_ASSOCIATED_DATA_BYTES = 512;
const MAX_PLAINTEXT_BYTES = 16_384;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

type OidcSecretKeyMaterial = Readonly<{
  version: string;
  key: string;
}>;

type TemporaryBufferKind =
  | 'configuration-key'
  | 'seal-plaintext'
  | 'open-nonce'
  | 'open-tag'
  | 'open-ciphertext'
  | 'open-plaintext-update'
  | 'open-plaintext-final'
  | 'open-plaintext-output';
type TemporaryBufferObserver = (
  kind: TemporaryBufferKind,
  clearedBuffer: Buffer,
) => void;

export type OidcSecretEncryptionConfig = Readonly<{
  current: OidcSecretKeyMaterial;
  previous?: readonly OidcSecretKeyMaterial[];
}>;

export class OidcSecretEncryptionError extends Error {
  public override readonly name = 'OidcSecretEncryptionError';
}

function configurationError(): never {
  throw new OidcSecretEncryptionError(
    'OIDC secret encryption configuration is invalid',
  );
}

function operationError(): never {
  throw new OidcSecretEncryptionError('OIDC secret encryption failed');
}

function clearOwnedBuffer(
  buffer: Buffer | undefined,
  kind: TemporaryBufferKind,
  observer: TemporaryBufferObserver | undefined,
): void {
  if (buffer === undefined) return;
  buffer.fill(0);
  try {
    observer?.(kind, buffer);
  } catch {
    // Test-only observation must not alter encryption behavior.
  }
}

function decodeKeyMaterial(
  value: unknown,
  observer: TemporaryBufferObserver | undefined,
): Buffer {
  if (typeof value !== 'string' || value.length === 0) configurationError();

  const isStandardBase64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    );
  const isBase64Url = /^[A-Za-z0-9_-]+$/u.test(value);
  if (!isStandardBase64 && !isBase64Url) configurationError();

  const decoded = Buffer.from(value, isStandardBase64 ? 'base64' : 'base64url');
  if (decoded.byteLength !== AES_KEY_BYTES) {
    clearOwnedBuffer(decoded, 'configuration-key', observer);
    configurationError();
  }

  const canonical = decoded.toString(isStandardBase64 ? 'base64' : 'base64url');
  if (canonical !== value) {
    clearOwnedBuffer(decoded, 'configuration-key', observer);
    configurationError();
  }
  return decoded;
}

function parseConfig(
  config: OidcSecretEncryptionConfig,
  observer: TemporaryBufferObserver | undefined,
): Readonly<{
  current: Readonly<{ version: string; key: Buffer }>;
  previous: ReadonlyMap<string, Buffer>;
}> {
  const rawConfig: unknown = config;
  if (rawConfig === null || typeof rawConfig !== 'object') configurationError();
  const configRecord = rawConfig as Record<string, unknown>;
  const previousValue = configRecord.previous;
  let previousEntries: readonly unknown[];
  if (previousValue === undefined) previousEntries = [];
  else if (Array.isArray(previousValue)) previousEntries = previousValue;
  else previousEntries = [previousValue];
  const entries: readonly unknown[] = [
    configRecord.current,
    ...previousEntries,
  ];
  const validatedEntries: OidcSecretKeyMaterial[] = [];
  const versions = new Set<string>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') configurationError();
    const entryRecord = entry as Record<string, unknown>;
    if (
      typeof entryRecord.version !== 'string' ||
      !KEY_VERSION_PATTERN.test(entryRecord.version) ||
      typeof entryRecord.key !== 'string' ||
      versions.has(entryRecord.version)
    ) {
      configurationError();
    }
    versions.add(entryRecord.version);
    validatedEntries.push({
      version: entryRecord.version,
      key: entryRecord.key,
    });
  }

  const parsed: { version: string; key: Buffer }[] = [];
  try {
    for (const entry of validatedEntries) {
      parsed.push({
        version: entry.version,
        key: decodeKeyMaterial(entry.key, observer),
      });
    }
  } catch (error: unknown) {
    for (const entry of parsed)
      clearOwnedBuffer(entry.key, 'configuration-key', observer);
    throw error;
  }

  const current = parsed[0];
  if (current === undefined) configurationError();
  return Object.freeze({
    current: Object.freeze(current),
    previous: new Map(
      parsed.slice(1).map((entry) => [entry.version, entry.key]),
    ),
  });
}

function assertTextBounded(value: string, maximumBytes: number): void {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    operationError();
  }
}

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function decode(
  value: unknown,
  maximumBytes: number,
  kind: TemporaryBufferKind,
  observer: TemporaryBufferObserver | undefined,
): Buffer {
  if (typeof value !== 'string' || value.length === 0) operationError();
  if (value.length > Math.ceil((maximumBytes * 4) / 3)) operationError();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    operationError();
  }
  if (
    decoded.byteLength > maximumBytes ||
    decoded.toString('base64url') !== value
  ) {
    clearOwnedBuffer(decoded, kind, observer);
    operationError();
  }
  return decoded;
}

export class Aes256GcmOidcSecretEncryption implements OidcSecretEncryptionAdapter {
  private readonly current: Readonly<{ version: string; key: Buffer }>;
  private readonly keys: ReadonlyMap<string, Buffer>;

  public constructor(
    config: OidcSecretEncryptionConfig,
    /** @internal Test-only observer for this adapter's owned temporary buffers. */
    private readonly temporaryBufferObserver?: TemporaryBufferObserver,
  ) {
    const parsed = parseConfig(config, temporaryBufferObserver);
    this.current = parsed.current;
    this.keys = new Map([
      [parsed.current.version, parsed.current.key],
      ...parsed.previous,
    ]);
  }

  public seal(plaintext: string, associatedData: string): SealedOidcSecret {
    try {
      if (typeof plaintext !== 'string' || typeof associatedData !== 'string') {
        operationError();
      }
      assertTextBounded(plaintext, MAX_PLAINTEXT_BYTES);
      assertTextBounded(associatedData, MAX_ASSOCIATED_DATA_BYTES);
      const plaintextBuffer = Buffer.from(plaintext, 'utf8');
      try {
        const nonce = randomBytes(AES_GCM_NONCE_BYTES);
        const cipher = createCipheriv('aes-256-gcm', this.current.key, nonce);
        cipher.setAAD(Buffer.from(associatedData, 'utf8'));
        const ciphertext = Buffer.concat([
          cipher.update(plaintextBuffer),
          cipher.final(),
        ]);
        const tag = cipher.getAuthTag();
        if (tag.byteLength !== AES_GCM_TAG_BYTES) operationError();
        return Object.freeze({
          ciphertext: encode(ciphertext),
          nonce: encode(nonce),
          tag: encode(tag),
          keyVersion: this.current.version,
        });
      } finally {
        clearOwnedBuffer(
          plaintextBuffer,
          'seal-plaintext',
          this.temporaryBufferObserver,
        );
      }
    } catch (error: unknown) {
      if (error instanceof OidcSecretEncryptionError) throw error;
      operationError();
    }
  }

  public open(sealed: SealedOidcSecret, associatedData: string): string {
    try {
      const rawSealed: unknown = sealed;
      if (
        rawSealed === null ||
        typeof rawSealed !== 'object' ||
        typeof associatedData !== 'string'
      ) {
        operationError();
      }
      const sealedRecord = rawSealed as Record<string, unknown>;
      assertTextBounded(associatedData, MAX_ASSOCIATED_DATA_BYTES);
      if (
        typeof sealedRecord.keyVersion !== 'string' ||
        !KEY_VERSION_PATTERN.test(sealedRecord.keyVersion)
      ) {
        operationError();
      }
      const key = this.keys.get(sealedRecord.keyVersion);
      if (key === undefined) operationError();
      let nonce: Buffer | undefined;
      let tag: Buffer | undefined;
      let ciphertext: Buffer | undefined;
      let plaintextUpdate: Buffer | undefined;
      let plaintextFinal: Buffer | undefined;
      let plaintextOutput: Buffer | undefined;
      try {
        nonce = decode(
          sealedRecord.nonce,
          AES_GCM_NONCE_BYTES,
          'open-nonce',
          this.temporaryBufferObserver,
        );
        tag = decode(
          sealedRecord.tag,
          AES_GCM_TAG_BYTES,
          'open-tag',
          this.temporaryBufferObserver,
        );
        ciphertext = decode(
          sealedRecord.ciphertext,
          MAX_PLAINTEXT_BYTES,
          'open-ciphertext',
          this.temporaryBufferObserver,
        );
        if (
          nonce.byteLength !== AES_GCM_NONCE_BYTES ||
          tag.byteLength !== AES_GCM_TAG_BYTES
        ) {
          operationError();
        }
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(Buffer.from(associatedData, 'utf8'));
        decipher.setAuthTag(tag);
        plaintextUpdate = decipher.update(ciphertext);
        plaintextFinal = decipher.final();
        plaintextOutput = Buffer.concat([plaintextUpdate, plaintextFinal]);
        if (plaintextOutput.byteLength > MAX_PLAINTEXT_BYTES) operationError();
        return plaintextOutput.toString('utf8');
      } finally {
        clearOwnedBuffer(
          plaintextUpdate,
          'open-plaintext-update',
          this.temporaryBufferObserver,
        );
        clearOwnedBuffer(
          plaintextFinal,
          'open-plaintext-final',
          this.temporaryBufferObserver,
        );
        clearOwnedBuffer(
          plaintextOutput,
          'open-plaintext-output',
          this.temporaryBufferObserver,
        );
        clearOwnedBuffer(nonce, 'open-nonce', this.temporaryBufferObserver);
        clearOwnedBuffer(tag, 'open-tag', this.temporaryBufferObserver);
        clearOwnedBuffer(
          ciphertext,
          'open-ciphertext',
          this.temporaryBufferObserver,
        );
      }
    } catch (error: unknown) {
      if (error instanceof OidcSecretEncryptionError) throw error;
      operationError();
    }
  }
}

export function createOidcSecretEncryptionAdapter(
  config: OidcSecretEncryptionConfig,
): Aes256GcmOidcSecretEncryption {
  return new Aes256GcmOidcSecretEncryption(config);
}
