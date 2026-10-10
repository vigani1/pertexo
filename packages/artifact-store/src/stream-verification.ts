import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { TransformCallback , Readable} from 'node:stream';

import {
  ArtifactInputIntegrityError,
  ArtifactIntegrityError,
} from './errors.js';
import type { ArtifactMetadata } from './store.js';

class VerifyingTransform extends Transform {
  private readonly hash = createHash('sha256');
  private bytesSeen = 0;

  public constructor(
    private readonly expectedBytes: number,
    private readonly expectedSha256: string,
    private readonly maximumBytes: number,
    private readonly source: 'input' | 'stored',
  ) {
    super();
  }

  public override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, encoding);
    this.bytesSeen += buffer.byteLength;
    if (
      this.bytesSeen > this.expectedBytes ||
      this.bytesSeen > this.maximumBytes
    ) {
      callback(this.integrityError('Artifact body exceeds its bound'));
      return;
    }

    this.hash.update(buffer);
    callback(null, buffer);
  }

  public override _flush(callback: TransformCallback): void {
    const actualSha256 = this.hash.digest('hex');
    if (
      this.bytesSeen !== this.expectedBytes ||
      actualSha256 !== this.expectedSha256
    ) {
      callback(
        this.integrityError(
          'Artifact body does not match its declared length and SHA-256',
        ),
      );
      return;
    }
    callback();
  }

  private integrityError(message: string): ArtifactIntegrityError {
    return this.source === 'input'
      ? new ArtifactInputIntegrityError(message)
      : new ArtifactIntegrityError(message);
  }
}

export function verifiedBody(
  body: Readable,
  metadata: ArtifactMetadata,
  maxObjectBytes: number,
  source: 'input' | 'stored',
  signal?: AbortSignal,
): Readable {
  const verifier = new VerifyingTransform(
    metadata.byteLength,
    metadata.sha256,
    maxObjectBytes,
    source,
  );
  body.once('error', (error: Error) => {
    verifier.destroy(error);
  });
  const abort = (): void => {
    verifier.destroy(abortError(signal));
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  }
  verifier.once('close', () => {
    signal?.removeEventListener('abort', abort);
    if (!body.destroyed) {
      body.destroy();
    }
  });
  return body.pipe(verifier);
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  try {
    if (reason instanceof Error) return reason;
  } catch {
    // Cancellation values are untrusted at this boundary.
  }
  return new Error('Artifact transfer aborted', { cause: reason });
}
