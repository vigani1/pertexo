import type { Readable } from 'node:stream';
/** Attempt-local immutable bytes. Never persist this handle or expose a filesystem path. */
export interface NodeVerifiedByteSource {
  readonly byteLength: number;
  readonly sha256: string;
  open(signal: AbortSignal): Readable;
  release(): Promise<void>;
}
