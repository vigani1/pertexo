import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import {
  getWorkflowDraft,
  workflowDraftKeys,
} from '@/features/workflow-editor/draft.public';
import { restoreWorkflowVersion } from '@/features/workflow-versions/public';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { canonicalizeJson } from '@/lib/canonical-json';

export type RestoreRecovery =
  'check-outcome' | 'retry-original' | 'confirm-replacement';

interface RestoreAttempt {
  version: WorkflowVersionResponse;
  expectedEtag: string;
  replacementEtag?: string;
  mode: RestoreRecovery;
  uncertain: boolean;
}

/**
 * Replaces the draft with a published version. The draft's ETag is read once
 * per attempt; an uncertain or conflicting result is reconciled against the
 * current draft before anything is sent again, so a newer draft is never
 * overwritten without an explicit second confirmation.
 */
export function useWorkflowVersionRestore({
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
  const [error, setError] = useState<string>();
  const [recovery, setRecovery] = useState<RestoreRecovery>();
  const pendingRef = useRef(false);
  const attemptRef = useRef<RestoreAttempt | undefined>(undefined);

  async function complete() {
    attemptRef.current = undefined;
    setRecovery(undefined);
    setError(undefined);
    await queryClient.invalidateQueries({
      queryKey: workflowDraftKeys.detail(userId, workspaceId, workflowId),
    });
    return true;
  }

  function recover(
    attempt: RestoreAttempt,
    mode: RestoreRecovery,
    message: string,
  ) {
    attempt.mode = mode;
    setRecovery(mode);
    setError(message);
    return false;
  }

  async function reconcile() {
    const attempt = attemptRef.current;
    if (attempt === undefined) return false;
    try {
      const current = await getWorkflowDraft(
        apiClient,
        workspaceId,
        workflowId,
      );
      if (
        canonicalizeJson(current.draft.graph) ===
        canonicalizeJson(attempt.version.graph)
      )
        return await complete();
      if (attempt.uncertain && current.etag === attempt.expectedEtag)
        return recover(
          attempt,
          'retry-original',
          'The restore wasn’t applied. Retrying is safe — it only replaces the draft you saw.',
        );
      attempt.replacementEtag = current.etag;
      return recover(
        attempt,
        'confirm-replacement',
        'The draft changed while this restore was pending. Review the newer draft in Build, or replace it anyway.',
      );
    } catch {
      return recover(
        attempt,
        'check-outcome',
        'We couldn’t check whether the restore went through. Check again before restoring.',
      );
    }
  }

  async function send(version: WorkflowVersionResponse): Promise<boolean> {
    let attempt = attemptRef.current;
    if (attempt === undefined) {
      const snapshot = await getWorkflowDraft(
        apiClient,
        workspaceId,
        workflowId,
      );
      attempt = {
        version,
        expectedEtag: snapshot.etag,
        mode: 'retry-original',
        uncertain: false,
      };
      attemptRef.current = attempt;
    } else if (attempt.mode === 'check-outcome') {
      return reconcile();
    } else if (attempt.mode === 'confirm-replacement') {
      if (attempt.replacementEtag === undefined) return false;
      attempt.expectedEtag = attempt.replacementEtag;
      delete attempt.replacementEtag;
      attempt.uncertain = false;
    }
    await restoreWorkflowVersion(
      apiClient,
      workspaceId,
      workflowId,
      attempt.version.id,
      attempt.expectedEtag,
    );
    return complete();
  }

  async function restore(version: WorkflowVersionResponse) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      return await send(version);
    } catch (cause) {
      const uncertain = isUncertainOutcome(cause);
      const attempt = attemptRef.current;
      if (
        attempt !== undefined &&
        (uncertain || (isApiError(cause) && cause.status === 412))
      ) {
        attempt.uncertain = uncertain;
        attempt.mode = 'check-outcome';
        return await reconcile();
      }
      attemptRef.current = undefined;
      setRecovery(undefined);
      setError(describeCommandError(cause, 'restoring this version'));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return {
    pending,
    error,
    recovery,
    dismiss: () => {
      attemptRef.current = undefined;
      setRecovery(undefined);
      setError(undefined);
    },
    restore,
  };
}
