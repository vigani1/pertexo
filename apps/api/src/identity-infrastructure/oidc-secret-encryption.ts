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

function decodeKeyMaterial(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0) configurationError();

  const isStandardBase64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    );
  const isBase64Url = /^[A-Za-z0-9_-]+$/u.test(value);
  if (!isStandardBase64 && !isBase64Url) configurationError();

  const decoded = Buffer.from(value, isStandardBase64 ? 'base64' : 'base64url');
  if (decoded.byteLength !== AES_KEY_BYTES) configurationError();

  const canonical = decoded.toString(isStandardBase64 ? 'base64' : 'base64url');
  if (canonical !== value) configurationError();
  return decoded;
}

function parseConfig(config: OidcSecretEncryptionConfig): Readonly<{
  current: Readonly<{ version: string; key: Buffer }>;
  previous: ReadonlyMap<string, Buffer>;
}> {
  const rawConfig: unknown = config;
  if (rawConfig === null || typeof rawConfig !== 'object') configurationError();
  const configRecord = rawConfig as Record<string, unknown>;
  const previous = configRecord.previous;
  const entries: unknown[] = [
    configRecord.current,
    ...(previous === undefined
      ? []
      : Array.isArray(previous)
        ? (previous as readonly unknown[])
        : [previous]),
  ];
  const isKeyEntry = (entry: unknown): entry is OidcSecretKeyMaterial =>
    entry !== null &&
    typeof entry === 'object' &&
    typeof (entry as { version?: unknown }).version === 'string' &&
    KEY_VERSION_PATTERN.test((entry as { version: string }).version) &&
    typeof (entry as { key?: unknown }).key === 'string';
  const validEntries = entries.filter(isKeyEntry);
  if (entries.length === 0 || validEntries.length !== entries.length) {
    configurationError();
  }

  const parsed = validEntries.map((entry) => ({
    version: entry.version,
    key: decodeKeyMaterial(entry.key),
  }));
  const versions = new Set(parsed.map((entry) => entry.version));
  if (versions.size !== parsed.length) configurationError();

  const current = parsed[0];
  if (current === undefined) configurationError();
  return Object.freeze({
    current: Object.freeze(current),
    previous: new Map(
      parsed.slice(1).map((entry) => [entry.version, entry.key]),
    ),
  });
}

function assertTextBounded(value: string, label: string): void {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') >
      (label === 'associated data'
        ? MAX_ASSOCIATED_DATA_BYTES
        : MAX_PLAINTEXT_BYTES)
  ) {
    operationError();
  }
}

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function decode(value: unknown, maximumBytes: number): Buffer {
  if (typeof value !== 'string' || value.length === 0) operationError();
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
    operationError();
  }
  return decoded;
}

export class Aes256GcmOidcSecretEncryption implements OidcSecretEncryptionAdapter {
  private readonly current: Readonly<{ version: string; key: Buffer }>;
  private readonly keys: ReadonlyMap<string, Buffer>;

  public constructor(config: OidcSecretEncryptionConfig) {
    const parsed = parseConfig(config);
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
      assertTextBounded(plaintext, 'plaintext');
      assertTextBounded(associatedData, 'associated data');
      const nonce = randomBytes(AES_GCM_NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', this.current.key, nonce);
      cipher.setAAD(Buffer.from(associatedData, 'utf8'));
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(plaintext, 'utf8')),
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
      assertTextBounded(associatedData, 'associated data');
      if (
        typeof sealedRecord.keyVersion !== 'string' ||
        !KEY_VERSION_PATTERN.test(sealedRecord.keyVersion)
      ) {
        operationError();
      }
      const key = this.keys.get(sealedRecord.keyVersion);
      if (key === undefined) operationError();
      const nonce = decode(sealedRecord.nonce, AES_GCM_NONCE_BYTES);
      const tag = decode(sealedRecord.tag, AES_GCM_TAG_BYTES);
      const ciphertext = decode(sealedRecord.ciphertext, MAX_PLAINTEXT_BYTES);
      if (
        nonce.byteLength !== AES_GCM_NONCE_BYTES ||
        tag.byteLength !== AES_GCM_TAG_BYTES
      ) {
        operationError();
      }
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) operationError();
      return plaintext.toString('utf8');
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
