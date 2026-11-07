import {
  reconcileQuerySnapshot,
  recoverRevisionConflict,
  isRevisionConflict,
} from '../api/query-snapshot';
import { useState } from 'react';
import {
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useRetainedCommand } from '../api/commands/use-retained';
import { isApiError } from '../api/error';
/** Unsaved edits own a snapshot only after an edit. Refetches never replace it. */
export function useSharingEditor<
  Snapshot extends { readonly revision: number },
>({
  resourceId,
  queryKey,
  invalidationKey,
  read,
  replace,
  onSaved,
}: Readonly<{
  resourceId: string | undefined;
  queryKey: QueryKey;
  invalidationKey: QueryKey;
  read: (signal: AbortSignal) => Promise<Snapshot>;
  replace: (snapshot: Snapshot, key: string) => Promise<unknown>;
  /** Called once the saved grants have been read back. */
  onSaved?: (() => void) | undefined;
}>) {
  const cache = useQueryClient();
  const reader = useQuery({
    queryKey,
    queryFn: ({ signal }) => read(signal),
    enabled: resourceId !== undefined,
    retry: false,
  });
  const [edited, setEdited] =
    useState<Readonly<{ resourceId: string; snapshot: Snapshot }>>();
  const command = useRetainedCommand(
    replace,
    async () => {
      // A receipt confirms the command, not the current grants. Read them again.
      const refreshed = await reconcileQuerySnapshot<Snapshot>(
        cache,
        queryKey,
        { kind: 'read' },
      );
      await cache.invalidateQueries(
        { queryKey: invalidationKey },
        { cancelRefetch: false },
      );
      if (refreshed !== undefined) {
        setEdited(undefined);
        onSaved?.();
      }
    },
    {
      action: 'saving sharing',
      onRefused: async (cause) => {
        await recoverRevisionConflict(cache, queryKey, cause);
      },
    },
  );
  const revisionConflict = isRevisionConflict(command.cause);
  const denied =
    reader.isError &&
    isApiError(reader.error) &&
    [401, 403, 404].includes(reader.error.status ?? 0);
  function currentSnapshot(): Snapshot | undefined {
    if (denied || resourceId === undefined) return undefined;
    return edited?.resourceId === resourceId ? edited.snapshot : reader.data;
  }
  const snapshot = currentSnapshot();
  const locked = command.pending || command.uncertain || command.expired;
  const closeLocked =
    command.pending || (command.uncertain && !command.expired);
  const stale =
    snapshot !== undefined &&
    reader.data !== undefined &&
    (snapshot.revision !== reader.data.revision || revisionConflict);
  const canChangeSharing =
    snapshot !== undefined && !locked && !stale && reader.isSuccess;
  // Reading the current grants does not create an edit to save.
  const canSaveChanges = canChangeSharing && snapshot !== reader.data;
  return {
    reader,
    readFailure: sharingReadFailure(reader, locked),
    snapshot,
    // The current-sharing notice owns definite conflict recovery feedback.
    command:
      revisionConflict && !command.uncertain
        ? { ...command, error: undefined }
        : command,
    locked,
    closeLocked,
    stale,
    canSaveChanges,
    canReview:
      reader.isSuccess &&
      !reader.isFetching &&
      snapshot !== undefined &&
      reader.data.revision !== snapshot.revision,
    review: () => {
      if (
        locked ||
        resourceId === undefined ||
        snapshot === undefined ||
        reader.data === undefined ||
        !reader.isSuccess ||
        reader.isFetching ||
        reader.data.revision === snapshot.revision
      )
        return;
      setEdited({
        resourceId,
        snapshot: { ...snapshot, revision: reader.data.revision },
      });
      command.reset();
    },
    update: (change: (snapshot: Snapshot) => Snapshot) => {
      if (snapshot === undefined || resourceId === undefined || locked) return;
      command.reset();
      setEdited({ resourceId, snapshot: change(snapshot) });
    },
    submit: async () => {
      if (canChangeSharing) await command.send(snapshot);
    },
    reload: async () => {
      if (locked) return;
      const next = await reader.refetch();
      if (next.isSuccess) {
        setEdited(undefined);
        command.reset();
      }
    },
    discard: () => {
      if (!closeLocked) {
        setEdited(undefined);
        command.reset();
      }
    },
  };
}

/** Retrying a read never changes the locally edited snapshot. */
function sharingReadFailure<Value>(
  reader: UseQueryResult<Value>,
  locked: boolean,
) {
  if (!reader.isError) return undefined;
  return {
    error: reader.error,
    retrying: reader.isFetching,
    retry: () => {
      if (!locked) void reader.refetch();
    },
  };
}
