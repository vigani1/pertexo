import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { EditorStore } from './editor.store';
import type { WorkflowDraftSnapshot } from '../workflow-editor.api';

export type SaveCoordinatorTransport = Readonly<{
  save: (
    graph: WorkflowGraphContract,
    etag: string,
    signal: AbortSignal,
  ) => Promise<WorkflowDraftSnapshot>;
  reload: (signal: AbortSignal) => Promise<WorkflowDraftSnapshot>;
  isConflict: (error: unknown) => boolean;
  isUncertain: (error: unknown) => boolean;
  message: (error: unknown) => string;
}>;

/**
 * Quiet time after the last edit before a save. Live-applied inspector edits
 * land here too, so a busy session stays well inside the draft-save limit.
 */
export const SAVE_DEBOUNCE_MS = 1_000;

export type SaveCoordinator = Readonly<{
  schedule: () => void;
  flush: () => Promise<void>;
  destroy: () => void;
}>;

export function createSaveCoordinator(
  store: EditorStore,
  transport: SaveCoordinatorTransport,
  debounceMs = SAVE_DEBOUNCE_MS,
): SaveCoordinator {
  let timer: number | undefined;
  let active: Promise<void> | null = null;
  let activeRequest: AbortController | undefined;
  let destroyed = false;

  function isDestroyed() {
    return destroyed;
  }

  function cancelTimer() {
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timer = undefined;
  }

  async function reconcileUncertain(
    snapshot: Readonly<{
      graph: WorkflowGraphContract;
      generation: number;
    }>,
    error: unknown,
    signal: AbortSignal,
  ) {
    try {
      const remote = await transport.reload(signal);
      if (isDestroyed()) return;
      if (graphsEqual(remote.draft.graph, snapshot.graph)) {
        store
          .getState()
          .acceptSave(
            remote.etag,
            remote.draft.revision,
            snapshot.generation,
            remote.draft.updatedAt,
          );
        return;
      }
      store.getState().reportConflict({
        local: store.getState().graph,
        remote: remote.draft.graph,
        remoteEtag: remote.etag,
        remoteRevision: remote.draft.revision,
      });
    } catch {
      if (isDestroyed()) return;
      store.getState().reportFailure(transport.message(error), true);
    }
  }

  async function performSave() {
    const current = store.getState();
    if (
      destroyed ||
      current.saveStatus === 'clean' ||
      current.saveStatus === 'conflict'
    )
      return;
    const snapshot = {
      graph: current.graph,
      etag: current.etag,
      generation: current.generation,
    };
    const request = new AbortController();
    activeRequest = request;
    current.beginSave();
    try {
      const saved = await transport.save(
        snapshot.graph,
        snapshot.etag,
        request.signal,
      );
      if (isDestroyed()) return;
      store
        .getState()
        .acceptSave(
          saved.etag,
          saved.draft.revision,
          snapshot.generation,
          saved.draft.updatedAt,
        );
    } catch (error) {
      if (isDestroyed()) return;
      if (transport.isConflict(error)) {
        try {
          const remote = await transport.reload(request.signal);
          if (isDestroyed()) return;
          store.getState().reportConflict({
            local: store.getState().graph,
            remote: remote.draft.graph,
            remoteEtag: remote.etag,
            remoteRevision: remote.draft.revision,
          });
        } catch (reloadError) {
          if (isDestroyed()) return;
          store.getState().reportFailure(transport.message(reloadError), true);
        }
      } else if (transport.isUncertain(error)) {
        await reconcileUncertain(snapshot, error, request.signal);
      } else {
        store.getState().reportFailure(transport.message(error), false);
      }
    } finally {
      if (activeRequest === request) activeRequest = undefined;
    }
  }

  async function flush() {
    if (destroyed) return;
    cancelTimer();
    if (active !== null) {
      await active;
      if (isDestroyed() || store.getState().saveStatus !== 'dirty') return;
    }
    active = performSave().finally(() => {
      active = null;
    });
    await active;
    if (!isDestroyed() && store.getState().saveStatus === 'dirty')
      await flush();
  }

  function schedule() {
    if (destroyed || store.getState().saveStatus === 'conflict') return;
    cancelTimer();
    timer = window.setTimeout(() => void flush(), debounceMs);
  }

  function destroy() {
    destroyed = true;
    cancelTimer();
    activeRequest?.abort();
    activeRequest = undefined;
  }

  return Object.freeze({ schedule, flush, destroy });
}

function graphsEqual(
  left: WorkflowGraphContract,
  right: WorkflowGraphContract,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
