import { pipeline, Transform, type Readable } from 'node:stream';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { ArtifactSourceCleanupError } from './consume.js';
const NO_PROGRESS_MILLIS = 60_000;
function timedOut(deadline: boolean): NodeExecutorFailure {
  return new NodeExecutorFailure({
    kind: 'retry',
    errorKind: 'timeout',
    possiblyDispatched: false,
    safeErrorCode: deadline
      ? 'execution.file_deadline'
      : 'execution.file_progress_timeout',
    errorSummary: deadline
      ? 'The execution deadline expired during the file transfer.'
      : 'The file transfer made no byte progress for 60 seconds. Check storage or the receiving service before retrying.',
  });
}
/** One byte-progress/deadline owner, including a native source's cancellation. */
export class ArtifactTransfer {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private cancelFailed = false;
  private cancel: ((reason: Error) => void) | undefined;
  readonly signal: AbortSignal = this.controller.signal;
  private readonly abortParent = () => {
    this.abort(
      new NodeExecutorFailure({
        kind: 'canceled',
        errorKind: 'canceled',
        possiblyDispatched: false,
      }),
    );
  };
  constructor(
    private readonly parent: AbortSignal,
    private readonly deadline?: Date,
    cancel?: (reason: Error) => void,
  ) {
    this.cancel = cancel;
    parent.addEventListener('abort', this.abortParent, { once: true });
    if (parent.aborted) this.abortParent();
    else this.advance();
  }
  ownSource(cancel: (reason: Error) => void): void {
    this.cancel = cancel;
    if (this.signal.aborted)
      this.cancelSource(
        this.signal.reason instanceof Error
          ? this.signal.reason
          : timedOut(false),
      );
  }
  advance(): void {
    if (this.closed || this.signal.aborted) return;
    clearTimeout(this.timer);
    const remaining =
      this.deadline === undefined
        ? Infinity
        : this.deadline.getTime() - Date.now();
    const deadline = remaining <= NO_PROGRESS_MILLIS;
    this.timer = setTimeout(
      () => {
        this.abort(timedOut(deadline));
      },
      Math.max(0, Math.min(NO_PROGRESS_MILLIS, remaining)),
    );
    this.timer.unref();
  }
  private cancelSource(reason: Error): void {
    try {
      this.cancel?.(reason);
    } catch {
      this.cancelFailed = true;
    }
  }
  private abort(reason: Error): void {
    if (this.signal.aborted || this.closed) return;
    clearTimeout(this.timer);
    this.controller.abort(reason);
    this.cancelSource(reason);
  }
  finish(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.parent.removeEventListener('abort', this.abortParent);
    if (this.cancelFailed) throw new ArtifactSourceCleanupError();
  }
}
export async function closeArtifactStream(source: Readable): Promise<void> {
  if (source.closed) return;
  const closed = new Promise<void>((resolve) => {
    source.once('close', resolve);
  });
  source.destroy();
  await closed;
}
/** A native stream propagates a stalled-source error even while its consumer is paused. */
export function withByteProgress(
  source: Readable,
  signal: AbortSignal,
  deadline?: Date,
): Readable {
  const mapError = () =>
    new NodeExecutorFailure({
      kind: 'retry',
      errorKind: 'internal',
      possiblyDispatched: false,
      safeErrorCode: 'execution.file_scratch_io',
      errorSummary:
        'File bytes could not be read. Check worker storage before retrying.',
    });
  const guarded = new Transform({
    readableHighWaterMark: 65536,
    writableHighWaterMark: 65536,
    transform(chunk: unknown, _encoding, callback) {
      if (!(chunk instanceof Uint8Array)) {
        callback(mapError());
        return;
      }
      if (chunk.byteLength > 0) transfer.advance();
      callback(null, chunk);
    },
  });
  guarded.on('error', () => undefined);
  const transfer = new ArtifactTransfer(signal, deadline, (reason) => {
    source.destroy(reason);
    guarded.destroy(reason);
  });
  source.on('error', (error: unknown) => {
    guarded.destroy(error instanceof NodeExecutorFailure ? error : mapError());
  });
  guarded.once('close', () => {
    source.destroy();
    // Native Readable.destroy does not throw; a failed source disposal still closes its file owner.
    try {
      transfer.finish();
    } catch {
      source.destroy();
    }
  });
  if (!transfer.signal.aborted) pipeline(source, guarded, () => undefined);
  return guarded;
}
