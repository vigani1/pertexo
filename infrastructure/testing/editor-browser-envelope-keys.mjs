import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Test-only KMS substitute shared by the owned API and worker fixtures. */
export function createEditorBrowserEnvelopeKeys(masterKey, purpose) {
  if (
    !(masterKey instanceof Uint8Array) ||
    masterKey.byteLength !== 32 ||
    !['connection', 'webhook'].includes(purpose)
  )
    throw new Error('Owned envelope configuration invalid');
  const key = Buffer.from(masterKey);
  const keyReference = `in-process://editor-browser-${purpose}-v1`;
  let closed = false;
  const associatedData = (context) => {
    const target = purpose === 'connection' ? 'connectionId' : 'triggerId';
    if (
      closed ||
      context === null ||
      typeof context !== 'object' ||
      Object.keys(context).sort().join(',') !==
        [target, 'secretVersionId', 'workspaceId'].sort().join(',') ||
      ![context.workspaceId, context[target], context.secretVersionId].every(
        (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/u.test(value),
      )
    )
      throw new Error('Owned envelope context invalid');
    return Buffer.from(
      [
        'editor-browser-key-wrap-v1',
        purpose,
        context.workspaceId,
        context[target],
        context.secretVersionId,
      ].join('\0'),
    );
  };
  return {
    async generateDataKey(context, signal) {
      let plaintextKey;
      try {
        signal?.throwIfAborted();
        const aad = associatedData(context);
        plaintextKey = randomBytes(32);
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([
          cipher.update(plaintextKey),
          cipher.final(),
        ]);
        return {
          plaintextKey,
          keyReference,
          encryptedDataKey: Buffer.concat([
            nonce,
            cipher.getAuthTag(),
            ciphertext,
          ]),
        };
      } catch {
        plaintextKey?.fill(0);
        throw new Error('Owned envelope key generation failed');
      }
    },
    async decryptDataKey(wrapped, reference, context, signal) {
      try {
        signal?.throwIfAborted();
        const aad = associatedData(context);
        if (
          reference !== keyReference ||
          !(wrapped instanceof Uint8Array) ||
          wrapped.byteLength !== 60
        )
          throw new Error('invalid wrapped key');
        const bytes = Buffer.from(wrapped);
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          bytes.subarray(0, 12),
        );
        decipher.setAAD(aad);
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]);
      } catch {
        throw new Error('Owned envelope key recovery failed');
      }
    },
    close() {
      closed = true;
      key.fill(0);
    },
  };
}
