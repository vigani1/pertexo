import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import {
  getWorkflowDraft,
  workflowDraftKeys,
} from '@/features/workflow-editor/draft.public';
import type { ApiClient } from '@/lib/api/client';
import { restoreWorkflowVersion } from '@/features/workflow-versions/public';
import { canonicalizeJson } from '@/lib/canonical-json';
import { isApiError } from '@/lib/api/api-error';
import { workflowKeys } from '@/features/workflows/public';
import { transitionWorkflowLifecycle } from '../workflow-settings.api';
import { workflowSettingsKeys } from '../workflow-settings.queries';
import { settingsCommandError } from './settings-command';

type WorkflowLifecycleCommand = Readonly<{
  command: 'archive' | 'restore';
  expectedLifecycleRevision: number;
  idempotencyKey: string;
}>;

export function useWorkflowLifecycleCommand({
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
  const commandRef = useRef<WorkflowLifecycleCommand | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(
    command: 'archive' | 'restore',
    expectedLifecycleRevision: number,
  ) {
    if (pending) return false;
    const exactCommand =
      commandRef.current ??
      (commandRef.current = {
        command,
        expectedLifecycleRevision,
        idempotencyKey: crypto.randomUUID(),
      });
    setPending(true);
    setError(undefined);
    try {
      await transitionWorkflowLifecycle(
        apiClient,
        workspaceId,
        workflowId,
        exactCommand,
      );
      commandRef.current = undefined;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workflowSettingsKeys.summary(
            userId,
            workspaceId,
            workflowId,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: workflowKeys.scope(userId, workspaceId),
        }),
      ]);
      return true;
    } catch (cause) {
      setError(
        settingsCommandError(cause, `${exactCommand.command} this workflow`),
      );
      return false;
    } finally {
      setPending(false);
    }
  }

  return {
    pending,
    error,
    reset: () => {
      commandRef.current = undefined;
      setError(undefined);
    },
    submit,
  };
}

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
  const [recovery, setRecovery] = useState<
    'check-outcome' | 'retry-original' | 'confirm-replacement'
  >();
  const pendingRef = useRef(false);
  const attemptRef = useRef<
    | {
        version: WorkflowVersionResponse;
        expectedEtag: string;
        replacementEtag?: string;
        mode: 'check-outcome' | 'retry-original' | 'confirm-replacement';
        uncertain: boolean;
      }
    | undefined
  >(undefined);

  async function complete() {
    attemptRef.current = undefined;
    setRecovery(undefined);
    setError(undefined);
    await queryClient.invalidateQueries({
      queryKey: workflowDraftKeys.detail(userId, workspaceId, workflowId),
    });
    return true;
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

      if (attempt.uncertain && current.etag === attempt.expectedEtag) {
        attempt.mode = 'retry-original';
        setRecovery('retry-original');
        setError(
          'The restore was not applied. Retry the same conditional request against the original draft version.',
        );
        return false;
      }

      attempt.mode = 'confirm-replacement';
      attempt.replacementEtag = current.etag;
      setRecovery('confirm-replacement');
      setError(
        'The draft changed while this restore was pending. Review the newer draft, then explicitly confirm if you still want to replace it.',
      );
      return false;
    } catch {
      attempt.mode = 'check-outcome';
      setRecovery('check-outcome');
      setError(
        'The restore outcome could not be checked. Check again before sending another conditional restore.',
      );
      return false;
    }
  }

  async function restore(version: WorkflowVersionResponse) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    try {
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
        return await reconcile();
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
      return await complete();
    } catch (cause) {
      const uncertain =
        isApiError(cause) &&
        ['network', 'timeout', 'protocol'].includes(cause.kind);
      if (uncertain || (isApiError(cause) && cause.status === 412)) {
        const attempt = attemptRef.current;
        if (attempt !== undefined) {
          attempt.uncertain = uncertain;
          attempt.mode = 'check-outcome';
          return await reconcile();
        }
      }
      attemptRef.current = undefined;
      setRecovery(undefined);
      setError('Could not restore this workflow version.');
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
