import { useState } from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
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
      const refreshed = reader.refetch({ cancelRefetch: false });
      await cache.invalidateQueries(
        { queryKey: invalidationKey },
        { cancelRefetch: false },
      );
      if ((await refreshed).isSuccess) {
        setEdited(undefined);
        onSaved?.();
      }
    },
    { action: 'saving sharing' },
  );
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
    snapshot.revision !== reader.data.revision;
  const canChangeSharing =
    snapshot !== undefined && !locked && !stale && reader.isSuccess;
  // Reading the current grants does not create an edit to save.
  const canSaveChanges = canChangeSharing && snapshot !== reader.data;
  return {
    reader,
    snapshot,
    command,
    locked,
    closeLocked,
    stale,
    canSaveChanges,
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
