import { useCallback, useMemo } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { getWorkflowDraft, saveWorkflowDraft } from './workflow-editor.api';
import type { EditorStore } from './model/editor.store';
import type { SaveCoordinatorTransport } from './model/save-coordinator';
import { useSaveCoordinator } from './use-save-coordinator';

export type SavedDraftIdentity = Readonly<{
  etag: string;
  generation: number;
  revision: number;
}>;

/**
 * Wires the save coordinator to the draft endpoint behind the identity
 * fence, and exposes the barrier every server command waits on: the exact
 * draft it will act on must be saved and still belong to this person.
 */
export function useEditorSavePipeline({
  apiClient,
  store,
  workspaceId,
  workflowId,
  canUpdate,
  paused,
  verifyOwner,
}: Readonly<{
  apiClient: ApiClient;
  store: EditorStore;
  workspaceId: string;
  workflowId: string;
  canUpdate: boolean;
  paused: boolean;
  verifyOwner: (signal?: AbortSignal) => Promise<void>;
}>) {
  const transport = useMemo<SaveCoordinatorTransport>(
    () => ({
      save: async (graph, etag, signal) => {
        await verifyOwner(signal);
        return saveWorkflowDraft(apiClient, workspaceId, workflowId, {
          graph,
          etag,
          signal,
        });
      },
      reload: (signal) =>
        getWorkflowDraft(apiClient, workspaceId, workflowId, signal),
      isConflict: (error) => isApiError(error) && error.status === 412,
      isUncertain: (error) =>
        isApiError(error) &&
        ['network', 'protocol', 'timeout'].includes(error.kind),
      message: editorSaveErrorMessage,
    }),
    [apiClient, verifyOwner, workflowId, workspaceId],
  );
  const flushSave = useSaveCoordinator(store, transport, canUpdate && !paused);

  const ensureSaved = useCallback(async (): Promise<SavedDraftIdentity> => {
    if (paused)
      throw new Error(
        'The editor is paused until your account is verified again.',
      );
    if (store.getState().inspectorScratch)
      throw new Error(
        'Finish or discard the unfinished edit in the step panel first.',
      );
    await verifyOwner();
    await flushSave();
    await verifyOwner();
    const state = store.getState();
    if (state.saveStatus !== 'clean')
      throw new Error(
        state.saveStatus === 'conflict'
          ? 'This draft changed elsewhere. Review the change before continuing.'
          : 'Your latest changes aren’t saved yet. Try again in a moment.',
      );
    return {
      etag: state.etag,
      generation: state.generation,
      revision: state.revision,
    };
  }, [flushSave, paused, store, verifyOwner]);

  return { flushSave, ensureSaved } as const;
}

function editorSaveErrorMessage(error: unknown): string {
  if (!isApiError(error)) return 'Your changes couldn’t be saved.';
  if (error.kind === 'network' || error.kind === 'timeout')
    return 'We couldn’t confirm the save. Your changes are still here.';
  if (error.status === 403)
    return 'Your role no longer allows editing this workflow.';
  if (error.status === 422)
    return 'The server rejected this draft. Check the step setup and try again.';
  if (error.status === 429)
    return 'Too many saves in a short time. Saving again shortly.';
  return 'Your changes couldn’t be saved. They’re still here.';
}
