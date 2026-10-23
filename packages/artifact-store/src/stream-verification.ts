import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { TransformCallback, Readable } from 'node:stream';

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
  {
    metadata,
    maxObjectBytes,
    source,
    signal,
  }: Readonly<{
    metadata: ArtifactMetadata;
    maxObjectBytes: number;
    source: 'input' | 'stored';
    signal?: AbortSignal | undefined;
  }>,
): Readable {
  const verifier = new VerifyingTransform(
    metadata.byteLength,
    metadata.sha256,
    maxObjectBytes,
    source,
  );
  // The caller (including the SDK uploader) owns consumption. Monitor both
  // ends without making the returned transform a pipeline destination, and
  // preserve early errors for a reader that has not attached yet.
  void finished(body, { cleanup: true, readable: true, writable: false }).catch(
    (error: unknown) => {
      verifier.destroy(transferError(error, 'Artifact transfer failed'));
    },
  );
  const closeTransfer = (): void => {
    signal?.removeEventListener('abort', abort);
    body.destroy();
  };
  void finished(verifier, { cleanup: true }).then(closeTransfer, closeTransfer);
  const abort = (): void => {
    verifier.destroy(
      transferError(signal?.reason, 'Artifact transfer aborted'),
    );
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  }
  return body.pipe(verifier);
}

function transferError(reason: unknown, message: string): Error {
  try {
    if (reason instanceof Error) return reason;
  } catch {
    // Transfer failures and cancellation reasons are untrusted at this boundary.
  }
  return new Error(message, { cause: reason });
}
