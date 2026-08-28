import {
  readRunEventsAfter,
  type WorkspaceDatabase,
} from '@pertexo/database/api';

import type {
  PersistedRunEvent,
  PersistedRunEventReader,
} from './run-event-stream.js';

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function createPostgresRunEventReader(
  database: WorkspaceDatabase,
): PersistedRunEventReader {
  return Object.freeze({
    readPage: async (
      input: Parameters<PersistedRunEventReader['readPage']>[0],
    ): Promise<readonly PersistedRunEvent[]> => {
      if (isAborted(input.signal)) return [];

      let page: Awaited<ReturnType<typeof readRunEventsAfter>>;
      try {
        page = await database.withWorkspace(
          input.workspaceId,
          async (transaction) =>
            readRunEventsAfter(transaction, {
              afterSequence: input.afterSequence,
              limit: input.limit,
              runId: input.runId,
            }),
          { signal: input.signal },
        );
      } catch (error: unknown) {
        if (isAborted(input.signal)) return [];
        throw error;
      }

      if (isAborted(input.signal)) return [];
      return Object.freeze(
        page.events.map((event) =>
          Object.freeze({
            createdAt: event.createdAt.toISOString(),
            payload: event.payload,
            sequence: event.sequence,
            type: event.type,
          }),
        ),
      );
    },
  });
}
