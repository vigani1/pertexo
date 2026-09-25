import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getWorkflowDraft,
  saveWorkflowDraft,
  workflowDraftKeys,
} from '@/features/workflow-editor/draft.public';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { maxRunDurationOf, withMaxRunDuration } from '../model/run-duration';

export type RunDurationProblem = Readonly<{
  message: string;
  /** Applying the same duration again, to the draft as it is now, is safe. */
  retry: boolean;
}>;

/**
 * Changes the maximum run duration in the draft, the way a version restore
 * does: it reads the draft and its ETag, changes only this setting and saves
 * with If-Match. A draft changed meanwhile (412) or an unconfirmed save is
 * checked against the draft before anything is sent again, and applying
 * again always starts from the latest draft, so other edits are never lost.
 */
export function useRunDurationChange({
  apiClient,
  userId,
  workspaceId,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
}>) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<RunDurationProblem>();
  const pendingRef = useRef(false);

  async function draftHas(durationMs: number): Promise<boolean> {
    const current = await getWorkflowDraft(apiClient, workspaceId, workflowId);
    return maxRunDurationOf(current.draft.graph) === durationMs;
  }

  async function recover(cause: unknown, durationMs: number) {
    const conflict = isApiError(cause) && cause.status === 412;
    if (conflict || isUncertainOutcome(cause)) {
      const applied = await draftHas(durationMs).catch(() => undefined);
      if (applied === true) return true;
      setProblem({
        message: conflict
          ? 'The draft changed while this was saving, so nothing changed. Apply it to the draft as it is now?'
          : 'We couldn’t confirm whether the draft saved. Try again: it only changes this setting.',
        retry: true,
      });
      return false;
    }
    setProblem({
      message: describeCommandError(cause, 'saving the maximum run duration'),
      retry: false,
    });
    return false;
  }

  async function apply(durationMs: number): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setProblem(undefined);
    try {
      const current = await getWorkflowDraft(
        apiClient,
        workspaceId,
        workflowId,
      );
      if (maxRunDurationOf(current.draft.graph) !== durationMs)
        await saveWorkflowDraft(apiClient, workspaceId, workflowId, {
          graph: withMaxRunDuration(current.draft.graph, durationMs),
          etag: current.etag,
        });
      return true;
    } catch (cause) {
      return await recover(cause, durationMs);
    } finally {
      await queryClient.invalidateQueries({
        queryKey: workflowDraftKeys.detail(userId, workspaceId, workflowId),
      });
      pendingRef.current = false;
      setPending(false);
    }
  }

  return {
    pending,
    problem,
    apply,
    dismiss: () => {
      setProblem(undefined);
    },
  };
}
