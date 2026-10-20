import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  statfs,
} from 'node:fs/promises';
import path from 'node:path';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

const ATTEMPT_BYTES = 20 * 1024 * 1024;
const WORKER_BYTES = 1024 * 1024 * 1024;
const HEADROOM_BYTES = 64 * 1024 * 1024;
const OWNED_DIRECTORY = /^spool-[A-Za-z0-9]{6}$/u;

function unavailable(reason: 'full' | 'io' | 'cleanup'): NodeExecutorFailure {
  return new NodeExecutorFailure({
    kind: 'retry',
    errorKind: 'internal',
    possiblyDispatched: false,
    safeErrorCode: `execution.file_scratch_${reason}`,
    errorSummary:
      reason === 'full'
        ? 'File scratch space is temporarily full. Retry after other file steps finish.'
        : 'File scratch space is unavailable. Check the worker storage before retrying.',
  });
}

export type ScratchFile = Readonly<{
  byteLength: number;
  sha256: string;
  open(): ReadStream;
  release(): Promise<void>;
}>;

/** One container's private disk space; failed cleanup never returns its charge. */
export class ArtifactScratchSpace {
  private readonly attempts = new Map<string, number>();
  private reserved = 0;
  private unwritten = 0;
  private cleanupFailed = false;

  private constructor(private readonly directory: string) {}

  static async create(directory: string): Promise<ArtifactScratchSpace> {
    try {
      if (
        !path.isAbsolute(directory) ||
        path.parse(directory).root === directory
      )
        throw new Error('File scratch requires a dedicated absolute directory');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const entry = await lstat(directory);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        (entry.mode & 0o777) !== 0o700 ||
        (process.getuid !== undefined && entry.uid !== process.getuid())
      )
        throw new Error(
          'File scratch directory must be private and owned by this worker',
        );
      const filesystem = await statfs(directory);
      if (filesystem.type === 0x01021994 || filesystem.type === 0x858458f6)
        throw new Error(
          'File scratch requires disk storage, not a memory filesystem',
        );
      for (const name of await readdir(directory))
        if (OWNED_DIRECTORY.test(name))
          await rm(path.join(directory, name), {
            recursive: true,
            force: true,
          });
      return new ArtifactScratchSpace(directory);
    } catch {
      throw new Error(
        'File scratch requires a private disk-backed directory with removable abandoned spools',
      );
    }
  }

  private async reserve(attemptId: string, bytes: number): Promise<() => void> {
    if (this.cleanupFailed) throw unavailable('cleanup');
    const attempt = this.attempts.get(attemptId) ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > ATTEMPT_BYTES)
      throw new TypeError('Invalid file scratch reservation');
    if (attempt + bytes > ATTEMPT_BYTES || this.reserved + bytes > WORKER_BYTES)
      throw unavailable('full');
    this.attempts.set(attemptId, attempt + bytes);
    this.reserved += bytes;
    this.unwritten += bytes;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const remaining = (this.attempts.get(attemptId) ?? 0) - bytes;
      if (remaining === 0) this.attempts.delete(attemptId);
      else this.attempts.set(attemptId, remaining);
      this.reserved -= bytes;
    };
    try {
      const filesystem = await statfs(this.directory);
      // Outstanding reservations cover writes that have not reached disk yet.
      if (
        filesystem.bavail * filesystem.bsize <
        HEADROOM_BYTES + this.unwritten
      )
        throw unavailable('full');
    } catch (error) {
      this.unwritten -= bytes;
      release();
      throw error instanceof NodeExecutorFailure ? error : unavailable('io');
    }
    return release;
  }

  /** Takes ownership of source chunks, clearing them after their bounded write. */
  async spool(
    input: Readonly<{
      attemptId: string;
      maxBytes: number;
      body: AsyncIterable<Uint8Array>;
      signal: AbortSignal;
    }>,
  ): Promise<ScratchFile> {
    input.signal.throwIfAborted();
    const returnReservation = await this.reserve(
      input.attemptId,
      input.maxBytes,
    );
    let directory: string | undefined;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let written = 0;
    let unwritten = input.maxBytes;
    const streams = new Set<ReadStream>();
    let releasing: Promise<void> | undefined;
    const cleanup = async (): Promise<void> => {
      try {
        await Promise.all(
          [...streams].map(async (stream) => {
            if (stream.closed) return;
            const closed = new Promise<void>((resolve) => {
              stream.once('close', resolve);
            });
            stream.destroy();
            await closed;
          }),
        );
        if (file !== undefined) {
          await file.close();
          file = undefined;
        }
        if (directory !== undefined)
          await rm(directory, { recursive: true, force: true });
      } catch {
        this.cleanupFailed = true;
        throw unavailable('cleanup');
      }
      this.unwritten -= unwritten;
      unwritten = 0;
      returnReservation();
    };
    const release = (): Promise<void> => (releasing ??= cleanup());
    try {
      directory = await mkdtemp(path.join(this.directory, 'spool-'));
      const filename = path.join(directory, 'body');
      file = await open(filename, 'wx', 0o600);
      const digest = createHash('sha256');
      for await (const chunk of input.body) {
        try {
          input.signal.throwIfAborted();
          if (written + chunk.byteLength > input.maxBytes)
            throw new NodeExecutorFailure({
              kind: 'failed',
              errorKind: 'configuration',
              possiblyDispatched: false,
              safeErrorCode: 'execution.file_size',
              errorSummary:
                'The file is too large. Split it into smaller files.',
            });
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const amount = Math.min(65_536, chunk.byteLength - offset);
            const result = await file.write(chunk, offset, amount);
            if (result.bytesWritten <= 0) throw unavailable('io');
            offset += result.bytesWritten;
            written += result.bytesWritten;
            unwritten -= result.bytesWritten;
            this.unwritten -= result.bytesWritten;
          }
        } finally {
          chunk.fill(0);
        }
      }
      input.signal.throwIfAborted();
      await file.close();
      file = undefined;
      return Object.freeze({
        byteLength: written,
        sha256: digest.digest('hex'),
        open: (): ReadStream => {
          if (releasing !== undefined) throw unavailable('io');
          const stream = createReadStream(filename, { highWaterMark: 65_536 });
          streams.add(stream);
          // Prevent unobserved errors during cancellation; consumers still see
          // the error through their iterator or pipeline.
          stream.on('error', () => undefined);
          stream.once('close', () => streams.delete(stream));
          return stream;
        },
        release,
      });
    } catch (error) {
      await release();
      if (input.signal.aborted) throw input.signal.reason;
      throw error instanceof NodeExecutorFailure ? error : unavailable('io');
    }
  }
}
