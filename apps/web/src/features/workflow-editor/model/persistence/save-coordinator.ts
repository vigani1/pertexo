import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { EditorStore } from '../state/store';
import type { WorkflowDraftSnapshot } from '../../data/workflow-editor.api';

export type SaveCoordinatorTransport = Readonly<{
  save: (
    graph: WorkflowGraphContract,
    etag: string,
    signal: AbortSignal,
  ) => Promise<WorkflowDraftSnapshot>;
  reload: (signal: AbortSignal) => Promise<WorkflowDraftSnapshot>;
  isConflict: (error: unknown) => boolean;
  isUncertain: (error: unknown) => boolean;
  /** How long a refusal asks the editor to wait before saving again. */
  retryAfterMs: (error: unknown) => number | undefined;
  message: (error: unknown) => string;
}>;

/**
 * Quiet time after the last edit before a save. Live-applied inspector edits
 * land here too, so a busy session stays well inside the draft-save limit.
 */
const SAVE_DEBOUNCE_MS = 1_000;
/** The longest a rate-limited save waits before trying on its own. */
const MAX_RETRY_WAIT_MS = 60_000;
/** Saves lost in a row, with the draft unchanged, before the editor says so. */
const MAX_LOST_SAVES = 3;

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
  let lostSaves = 0;

  function isDestroyed() {
    return destroyed;
  }

  function cancelTimer() {
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timer = undefined;
  }

  async function performSave() {
    const current = store.getState();
    if (
      destroyed ||
      current.save.status === 'clean' ||
      current.save.status === 'conflict'
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
      lostSaves = 0;
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
      if (transport.isConflict(error) || transport.isUncertain(error)) {
        const outcome = await reconcileRemoteSave(store, transport, {
          snapshot,
          signal: request.signal,
          isDestroyed,
          failureMessage: transport.isConflict(error)
            ? (cause) => transport.message(cause)
            : () => transport.message(error),
        });
        if (outcome !== 'unchanged') return;
        // Nothing landed and nobody else saved, so this save was simply lost.
        lostSaves += 1;
        if (lostSaves < MAX_LOST_SAVES) store.getState().requeueSave();
        else {
          lostSaves = 0;
          store.getState().reportFailure(transport.message(error), true);
        }
      } else {
        store.getState().reportFailure(transport.message(error), false);
        // A rate limit says when to come back, so saving resumes by itself.
        const wait = transport.retryAfterMs(error);
        if (wait !== undefined) {
          cancelTimer();
          timer = window.setTimeout(
            () => void flush(),
            Math.min(Math.max(wait, debounceMs), MAX_RETRY_WAIT_MS),
          );
        }
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
      if (isDestroyed() || store.getState().save.status !== 'dirty') return;
    }
    active = performSave().finally(() => {
      active = null;
    });
    await active;
    if (!isDestroyed() && store.getState().save.status === 'dirty')
      await flush();
  }

  function schedule() {
    if (destroyed || store.getState().save.status === 'conflict') return;
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

/** Reloading resolves a lost acknowledgement and an explicit version conflict alike. */
async function reconcileRemoteSave(
  store: EditorStore,
  transport: SaveCoordinatorTransport,
  options: Readonly<{
    snapshot: Readonly<{
      graph: WorkflowGraphContract;
      etag: string;
      generation: number;
    }>;
    signal: AbortSignal;
    isDestroyed: () => boolean;
    failureMessage: (error: unknown) => string;
  }>,
): Promise<'unchanged' | 'settled'> {
  const { snapshot, signal, isDestroyed, failureMessage } = options;
  try {
    const remote = await transport.reload(signal);
    if (isDestroyed()) return 'settled';
    if (graphsEqual(remote.draft.graph, snapshot.graph)) {
      store
        .getState()
        .acceptSave(
          remote.etag,
          remote.draft.revision,
          snapshot.generation,
          remote.draft.updatedAt,
        );
      return 'settled';
    }
    // The revision this save started from is still current: no one else wrote.
    if (remote.etag === snapshot.etag) return 'unchanged';
    store.getState().reportConflict({
      local: store.getState().graph,
      remote: remote.draft.graph,
      remoteEtag: remote.etag,
      remoteRevision: remote.draft.revision,
    });
  } catch (error) {
    if (!isDestroyed())
      store.getState().reportFailure(failureMessage(error), true);
  }
  return 'settled';
}
