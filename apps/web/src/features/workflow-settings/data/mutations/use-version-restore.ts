import {
  canResend,
  newCommandKey,
  RETRY_WINDOW_ENDED,
  type CommandKey,
  isUnconfirmedCommand,
} from '@/lib/api/commands/command-retry';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowVersionResponse } from '@pertexo/contracts';
import {
  getWorkflowDraft,
  workflowDraftKeys,
} from '@/features/workflow-editor/draft.public';
import { restoreWorkflowVersion } from '@/features/workflow-versions/public';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import { canonicalizeJson } from '@/lib/canonical-json';

export type RestoreRecovery =
  'check-outcome' | 'retry-original' | 'confirm-replacement';

type RestoreSuccess = Readonly<{ recoveryCopyId: string | null }>;
type RestoreResult = RestoreSuccess | false;

interface RestoreAttempt {
  version: WorkflowVersionResponse;
  command: CommandKey;
  expectedEtag: string;
  replacementEtag?: string;
  mode: RestoreRecovery;
  uncertain: boolean;
}

/**
 * Replaces the draft with a published version. The draft's ETag is read once
 * per attempt. An uncertain response replays that command's key to recover its
 * accepted result; a rejected stale attempt checks the current draft before
 * asking for an explicit replacement confirmation.
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

  async function complete(copyId: string | null) {
    attemptRef.current = undefined;
    setRecovery(undefined);
    setError(undefined);
    await queryClient.invalidateQueries({
      queryKey: workflowDraftKeys.detail(userId, workspaceId, workflowId),
    });
    return { recoveryCopyId: copyId };
  }

  function recover(
    attempt: RestoreAttempt,
    mode: RestoreRecovery,
    message: string,
  ): false {
    attempt.mode = mode;
    setRecovery(mode);
    setError(message);
    return false;
  }

  async function reconcile(): Promise<RestoreResult> {
    const attempt = attemptRef.current;
    if (attempt === undefined) return false;
    const outcome = await reconcileRestoreAttempt(
      { apiClient, workspaceId, workflowId },
      attempt,
    );
    return 'recoveryCopyId' in outcome
      ? complete(outcome.recoveryCopyId)
      : recover(attempt, outcome.mode, outcome.message);
  }

  async function send(
    version: WorkflowVersionResponse,
  ): Promise<RestoreResult> {
    let attempt = attemptRef.current;
    if (attempt === undefined) {
      const snapshot = await getWorkflowDraft(
        apiClient,
        workspaceId,
        workflowId,
      );
      attempt = {
        version,
        command: newCommandKey(),
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
      attempt.command = newCommandKey();
      delete attempt.replacementEtag;
    }
    const restored = await restoreWorkflowVersion({
      apiClient,
      workspaceId,
      workflowId,
      versionId: attempt.version.id,
      etag: attempt.expectedEtag,
      idempotencyKey: attempt.command.idempotencyKey,
    });
    return complete(restored.recoveryCopyId);
  }

  async function restore(
    version: WorkflowVersionResponse,
  ): Promise<RestoreResult> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      return await send(version);
    } catch (cause) {
      const uncertain = isUnconfirmedCommand(cause);
      const attempt = attemptRef.current;
      const keepRestoreAttempt =
        attempt !== undefined &&
        (uncertain || (isApiError(cause) && cause.status === 412));
      if (keepRestoreAttempt) {
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

/** Resolve command acknowledgement before comparing the mutable current draft. */
async function reconcileRestoreAttempt(
  target: Readonly<{
    apiClient: ApiClient;
    workspaceId: string;
    workflowId: string;
  }>,
  attempt: RestoreAttempt,
): Promise<
  RestoreSuccess | Readonly<{ mode: RestoreRecovery; message: string }>
> {
  const { apiClient, workspaceId, workflowId } = target;
  if (attempt.uncertain) {
    if (!canResend(attempt.command))
      return { mode: 'check-outcome', message: RETRY_WINDOW_ENDED };
    const accepted = await replayRestoreResult(
      { apiClient, workspaceId, workflowId },
      attempt,
    );
    if (accepted === 'unconfirmed')
      return {
        mode: 'check-outcome',
        message:
          'We couldn’t recover the restore result. Check again to find out whether a recovery copy was saved.',
      };
    if (accepted !== 'stale') return accepted;
    attempt.uncertain = false;
  }
  try {
    const current = await getWorkflowDraft(apiClient, workspaceId, workflowId);
    if (
      canonicalizeJson(current.draft.graph) ===
      canonicalizeJson(attempt.version.graph)
    )
      return { recoveryCopyId: null };
    attempt.replacementEtag = current.etag;
    return {
      mode: 'confirm-replacement',
      message:
        'The draft changed while this restore was pending. Review the newer draft in Build, or replace it anyway.',
    };
  } catch {
    return {
      mode: 'check-outcome',
      message:
        'We couldn’t check whether the restore went through. Check again before restoring.',
    };
  }
}

/** A stale rejection permits draft reconciliation; transport failure does not. */
async function replayRestoreResult(
  target: Readonly<{
    apiClient: ApiClient;
    workspaceId: string;
    workflowId: string;
  }>,
  attempt: RestoreAttempt,
): Promise<RestoreSuccess | 'stale' | 'unconfirmed'> {
  try {
    return await restoreWorkflowVersion({
      ...target,
      versionId: attempt.version.id,
      etag: attempt.expectedEtag,
      idempotencyKey: attempt.command.idempotencyKey,
    });
  } catch (cause) {
    return isApiError(cause) && cause.status === 412 ? 'stale' : 'unconfirmed';
  }
}
