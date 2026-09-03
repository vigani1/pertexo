import { Buffer } from 'node:buffer';

import { z } from 'zod';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_SSE_DATA_BYTES = 256 * 1_024;

const streamIdentitySchema = z
  .object({
    lastEventId: z.number().int().nonnegative(),
    runId: z.uuid(),
    workspaceId: z.uuid(),
  })
  .strict();

const eventTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

const persistedRunEventSchema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    payload: z.unknown(),
    sequence: z.number().int().positive(),
    type: eventTypeSchema,
  })
  .strict();

const liveEventNotificationSchema = z
  .object({
    kind: z.literal('event'),
    runId: z.uuid(),
    sequence: z.number().int().positive(),
    workspaceId: z.uuid(),
  })
  .strict();

const resyncNotificationSchema = z
  .object({ kind: z.literal('resync') })
  .strict();
const liveNotificationSchema = z.discriminatedUnion('kind', [
  liveEventNotificationSchema,
  resyncNotificationSchema,
]);

export function safeParseLiveRunEventNotification(
  value: unknown,
): LiveRunEventNotification | undefined {
  const parsed = liveNotificationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export type PersistedRunEvent = z.infer<typeof persistedRunEventSchema>;

export type LiveRunEventNotification =
  | z.infer<typeof liveEventNotificationSchema>
  | z.infer<typeof resyncNotificationSchema>;

export interface PersistedRunEventReader {
  /**
   * Returns at most `limit` events strictly after `afterSequence`, ordered by
   * sequence. The implementation must execute inside the workspace's RLS
   * context and must reject a run outside that workspace.
   */
  readPage(input: {
    readonly afterSequence: number;
    readonly limit: number;
    readonly runId: string;
    readonly signal: AbortSignal;
    readonly workspaceId: string;
  }): Promise<readonly PersistedRunEvent[]>;
}

export interface LiveRunEventSubscription extends AsyncIterable<LiveRunEventNotification> {
  close(): Promise<void>;
}

export interface LiveRunEventSource {
  /** Resolves only after the workspace/run-specific channel is subscribed. */
  subscribe(input: {
    readonly runId: string;
    readonly signal: AbortSignal;
    readonly workspaceId: string;
  }): Promise<LiveRunEventSubscription>;
}

export interface SseRunEventFrame {
  readonly data: string;
  readonly event: string;
  readonly id: number;
  /** Why persistence was read before this frame was emitted. */
  readonly visibilityPath:
    | 'initial_backfill'
    | 'reconnect_backfill'
    | 'live_wakeup'
    | 'recovery_backfill';
}

class RunEventStreamInvariantError extends Error {
  public override readonly name = 'RunEventStreamInvariantError';
}

interface StreamDependencies {
  readonly liveSource: LiveRunEventSource;
  readonly reader: PersistedRunEventReader;
}

interface StreamOptions {
  readonly pageSize?: number;
}

const ABORTED = Symbol('aborted');

function parsePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(
      `SSE event page size must be an integer between 1 and ${String(MAX_PAGE_SIZE)}`,
    );
  }
  return pageSize;
}

function frameForEvent(
  event: PersistedRunEvent,
  visibilityPath: SseRunEventFrame['visibilityPath'],
): SseRunEventFrame {
  const data = JSON.stringify(event);
  if (Buffer.byteLength(data, 'utf8') > MAX_SSE_DATA_BYTES) {
    throw new RunEventStreamInvariantError(
      'Persisted run event exceeds the bounded SSE data limit',
    );
  }
  return { data, event: event.type, id: event.sequence, visibilityPath };
}

async function nextOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | typeof ABORTED> {
  if (signal.aborted) {
    return ABORTED;
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      resolve(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Reconstructs one run's event stream from PostgreSQL. Redis notifications are
 * only wake-up hints: no event is emitted unless it is reread from persistence.
 */
export async function* streamRunEventFrames(
  input: {
    readonly lastEventId: number;
    readonly runId: string;
    readonly signal: AbortSignal;
    readonly workspaceId: string;
  },
  dependencies: StreamDependencies,
  options: StreamOptions = {},
): AsyncGenerator<SseRunEventFrame> {
  const identity = streamIdentitySchema.parse({
    lastEventId: input.lastEventId,
    runId: input.runId,
    workspaceId: input.workspaceId,
  });
  const pageSize = parsePageSize(options.pageSize);

  // Subscribe first. A commit racing the first database read is therefore
  // either in that read or retained as a live wake-up for the next read.
  const subscription = await dependencies.liveSource.subscribe({
    runId: identity.runId,
    signal: input.signal,
    workspaceId: identity.workspaceId,
  });
  let cursor = identity.lastEventId;
  const iterator = subscription[Symbol.asyncIterator]();

  const readPage = async (): Promise<readonly PersistedRunEvent[]> => {
    if (input.signal.aborted) {
      return [];
    }
    const page = await dependencies.reader.readPage({
      afterSequence: cursor,
      limit: pageSize,
      runId: identity.runId,
      signal: input.signal,
      workspaceId: identity.workspaceId,
    });
    return page.map((event) => persistedRunEventSchema.parse(event));
  };

  try {
    let shouldBackfill = true;
    let backfillPath: SseRunEventFrame['visibilityPath'] =
      identity.lastEventId === 0 ? 'initial_backfill' : 'reconnect_backfill';
    while (!input.signal.aborted) {
      if (shouldBackfill) {
        let page: readonly PersistedRunEvent[];
        do {
          page = await readPage();
          if (page.length > pageSize) {
            throw new RunEventStreamInvariantError(
              'Persisted event reader exceeded the requested page size',
            );
          }

          for (const event of page) {
            if (event.sequence !== cursor + 1) {
              throw new RunEventStreamInvariantError(
                `Persisted run event sequence is not contiguous after ${String(cursor)}`,
              );
            }
            cursor = event.sequence;
            yield frameForEvent(event, backfillPath);
          }
        } while (page.length === pageSize);
        shouldBackfill = false;
      }

      const next = await nextOrAbort(iterator, input.signal);
      if (next === ABORTED || next.done === true) {
        return;
      }

      const notification = safeParseLiveRunEventNotification(next.value);
      if (notification === undefined) {
        continue;
      }
      if (notification.kind === 'resync') {
        shouldBackfill = true;
        backfillPath = 'recovery_backfill';
        continue;
      }
      if (
        notification.workspaceId !== identity.workspaceId ||
        notification.runId !== identity.runId ||
        notification.sequence <= cursor
      ) {
        continue;
      }

      // A notification for a later sequence deliberately triggers a complete
      // bounded-page read after the cursor, repairing every intervening gap.
      shouldBackfill = true;
      backfillPath = 'live_wakeup';
    }
  } finally {
    await subscription.close();
    await iterator.return?.();
  }
}
