import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const sealedSchema = z
  .object({
    ciphertext: z.string().min(1).max(16_384),
    nonce: z.string().min(1).max(128),
    tag: z.string().min(1).max(256),
    keyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
  })
  .strict();

export type ApplicationSealedSecret = z.output<typeof sealedSchema>;
export type ApplicationSecretEnvelope = Readonly<{
  seal(plaintext: string, associatedData: string): ApplicationSealedSecret;
  open(sealed: ApplicationSealedSecret, associatedData: string): string;
}>;

export function createApplicationSecretEnvelope(
  config: Readonly<{
    current: Readonly<{ version: string; key: string }>;
    previous?: readonly Readonly<{ version: string; key: string }>[];
  }>,
): ApplicationSecretEnvelope {
  const entries = [config.current, ...(config.previous ?? [])];
  const keys = new Map(
    entries.map((entry) => {
      const base64url = entry.key
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
      const key = Buffer.from(base64url, 'base64url');
      if (key.byteLength !== 32 || key.toString('base64url') !== base64url)
        throw new TypeError(
          'Application secret key must encode exactly 32 bytes',
        );
      return [entry.version, key] as const;
    }),
  );
  const currentKey = keys.get(config.current.version);
  if (currentKey === undefined)
    throw new TypeError('Current application secret key is missing');

  return Object.freeze({
    seal: (plaintext, associatedData) => {
      assertBounded(plaintext, 12_288);
      assertBounded(associatedData, 512);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', currentKey, nonce);
      cipher.setAAD(Buffer.from(associatedData, 'utf8'));
      const input = Buffer.from(plaintext, 'utf8');
      try {
        const ciphertext = Buffer.concat([
          cipher.update(input),
          cipher.final(),
        ]);
        return sealedSchema.parse({
          ciphertext: ciphertext.toString('base64url'),
          nonce: nonce.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
          keyVersion: config.current.version,
        });
      } finally {
        input.fill(0);
        nonce.fill(0);
      }
    },
    open: (raw, associatedData) => {
      const sealed = sealedSchema.parse(raw);
      assertBounded(associatedData, 512);
      const key = keys.get(sealed.keyVersion);
      if (key === undefined)
        throw new Error('Application secret key is unavailable');
      const nonce = Buffer.from(sealed.nonce, 'base64url');
      const tag = Buffer.from(sealed.tag, 'base64url');
      const ciphertext = Buffer.from(sealed.ciphertext, 'base64url');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(Buffer.from(associatedData, 'utf8'));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        try {
          return plaintext.toString('utf8');
        } finally {
          plaintext.fill(0);
        }
      } finally {
        nonce.fill(0);
        tag.fill(0);
        ciphertext.fill(0);
      }
    },
  });
}

function assertBounded(value: string, maximumBytes: number): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  )
    throw new TypeError('Application secret input is invalid');
}
