import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { isApiError, UserFacingError } from '@/lib/api/error';
import { isUncertainOutcome } from '@/lib/api/error-copy';
import {
  getWorkflowDraft,
  saveWorkflowDraft,
  type WorkflowDraftSnapshot,
} from '../data/workflow-editor.api';
import { workflowDraftKeys } from '../data/workflow-editor.queries';
import type { EditorStore } from '../model/state/store';
import type { SaveCoordinatorTransport } from '../model/persistence/save-coordinator';
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
  userId,
  workspaceId,
  workflowId,
  canUpdate,
  paused,
  verifyOwner,
}: Readonly<{
  apiClient: ApiClient;
  store: EditorStore;
  userId: string;
  workspaceId: string;
  workflowId: string;
  canUpdate: boolean;
  paused: boolean;
  verifyOwner: (signal?: AbortSignal) => Promise<void>;
}>) {
  const queryClient = useQueryClient();
  const transport = useMemo<SaveCoordinatorTransport>(() => {
    const draftKey = workflowDraftKeys.detail(userId, workspaceId, workflowId);
    // The editor opens from the cached draft, so every draft the server
    // hands back lands there and coming back to Build shows the latest save.
    // A read already in flight may predate the save, so it can't land after.
    const remember = async (draft: WorkflowDraftSnapshot) => {
      await queryClient.cancelQueries({ queryKey: draftKey, exact: true });
      queryClient.setQueryData(draftKey, draft);
      return draft;
    };
    return {
      save: async (graph, etag, signal) => {
        await verifyOwner(signal);
        return remember(
          await saveWorkflowDraft(apiClient, workspaceId, workflowId, {
            graph,
            etag,
            signal,
          }),
        );
      },
      reload: async (signal) =>
        remember(
          await getWorkflowDraft(apiClient, workspaceId, workflowId, signal),
        ),
      isConflict: (error) => isApiError(error) && error.status === 412,
      isUncertain: isUncertainOutcome,
      retryAfterMs: (error) =>
        isApiError(error) && error.status === 429
          ? (error.retryAfterMs ?? RATE_LIMITED_WAIT_MS)
          : undefined,
      message: editorSaveErrorMessage,
    };
  }, [apiClient, queryClient, userId, verifyOwner, workflowId, workspaceId]);
  const flushSave = useSaveCoordinator({
    store,
    transport,
    enabled: canUpdate && !paused,
  });

  const ensureSaved = useCallback(async (): Promise<SavedDraftIdentity> => {
    if (paused)
      throw new UserFacingError(
        'The editor is paused until your account is verified again.',
      );
    if (store.getState().inspectorScratch)
      throw new UserFacingError(
        'Finish or discard the unfinished edit in the step panel first.',
      );
    await verifyOwner();
    await flushSave();
    await verifyOwner();
    const state = store.getState();
    if (state.save.status !== 'clean')
      throw new UserFacingError(
        state.save.status === 'conflict'
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

/** When a 429 carries no Retry-After, the wait before saving again. */
const RATE_LIMITED_WAIT_MS = 5_000;

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
