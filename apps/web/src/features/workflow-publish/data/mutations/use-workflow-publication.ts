import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { publishWorkflow } from '../workflow-publish.api';
import { workflowPublishKeys } from '../workflow-publish.queries';
import { isUncertainOutcome } from '@/lib/api/error-copy';
import { commandErrorMessage } from './command-utils';
import {
  useWorkflowDraftValidation,
  type SavedDraft,
} from './use-workflow-draft-validation';

type PublishAttempt = SavedDraft & Readonly<{ idempotencyKey: string }>;

export type PublicationReceipt = Readonly<{
  versionId: string;
  versionNumber: number;
  generation: number;
  revision: number;
}>;

export type PublishStage = 'saving' | 'checking' | 'publishing';
export type PublishResult =
  | Readonly<{ kind: 'published'; receipt: PublicationReceipt }>
  | Readonly<{ kind: 'blocked' | 'failed' }>;

const failed: PublishResult = { kind: 'failed' };

/**
 * Validation and publication of the saved draft. Publishing saves, checks the
 * exact saved revision (reusing a fresh report) and only then sends one
 * keyed command; an uncertain outcome keeps that command for an exact retry.
 */
export function useWorkflowPublication({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  verifyIdentity,
  ensureSaved,
  isSavedDraftCurrent,
  onPublicationAccepted,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  verifyIdentity: () => Promise<void>;
  ensureSaved: () => Promise<SavedDraft>;
  isSavedDraftCurrent: (saved: SavedDraft) => boolean;
  onPublicationAccepted?: () => void;
}>) {
  const queryClient = useQueryClient();
  const [publishStage, setPublishStage] = useState<PublishStage>();
  const [publishError, setPublishError] = useState<string>();
  const [publicationReceipt, setPublicationReceipt] =
    useState<PublicationReceipt>();
  const [publishRecoveryPending, setPublishRecoveryPending] = useState(false);
  const publishAttempt = useRef<PublishAttempt | undefined>(undefined);
  const owner = useRef<symbol | undefined>(undefined);
  const {
    validation,
    validationPending,
    validationError,
    validationBlockedUntil,
    validate,
    freshValidation,
    assertValidationAvailable,
    recordValidationCooldown,
    resetValidation,
  } = useWorkflowDraftValidation({
    apiClient,
    workspaceId,
    workflowId,
    owner,
    ensureSaved,
    isSavedDraftCurrent,
  });

  useEffect(() => {
    const currentOwner = Symbol('workflow-publication');
    owner.current = currentOwner;
    return () => {
      if (owner.current === currentOwner) {
        owner.current = undefined;
        publishAttempt.current = undefined;
        resetValidation();
      }
    };
  }, [apiClient, userId, workspaceId, workflowId, resetValidation]);

  async function prepareAttempt(
    publishOwner: symbol,
  ): Promise<PublishAttempt | 'blocked' | undefined> {
    setPublishStage('saving');
    const saved = await ensureSaved();
    if (owner.current !== publishOwner) return undefined;
    const checked = await freshValidation(saved, publishOwner, () => {
      setPublishStage('checking');
    });
    if (owner.current !== publishOwner || checked === undefined)
      return undefined;
    if (checked.etag !== saved.etag || !isSavedDraftCurrent(saved)) {
      setPublishError(
        'This check describes a different draft. Review the latest changes and check again before publishing.',
      );
      return 'blocked';
    }
    if (!checked.report.valid) return 'blocked';
    return { ...saved, idempotencyKey: crypto.randomUUID() };
  }

  async function publish(): Promise<PublishResult> {
    const publishOwner = owner.current;
    if (publishStage !== undefined || publishOwner === undefined) return failed;
    let dispatched = false;
    setPublishError(undefined);
    try {
      setPublishStage('saving');
      await verifyIdentity();
      if (owner.current !== publishOwner) return failed;
      if (publishAttempt.current === undefined) assertValidationAvailable();
      const prepared =
        publishAttempt.current ?? (await prepareAttempt(publishOwner));
      if (prepared === undefined) return failed;
      if (prepared === 'blocked') return { kind: 'blocked' };
      if (owner.current !== publishOwner) return failed;
      if (publishAttempt.current === undefined) assertValidationAvailable();
      if (
        publishAttempt.current === undefined &&
        !isSavedDraftCurrent(prepared)
      ) {
        setPublishError(
          'Your draft changed during the check. Review your changes and try again.',
        );
        return { kind: 'blocked' };
      }
      publishAttempt.current = prepared;
      dispatched = true;
      setPublishStage('publishing');
      const response = await publishWorkflow(
        apiClient,
        workspaceId,
        workflowId,
        { etag: prepared.etag, idempotencyKey: prepared.idempotencyKey },
      );
      if (owner.current !== publishOwner) return failed;
      publishAttempt.current = undefined;
      setPublishRecoveryPending(false);
      const receipt = {
        versionId: response.version.id,
        versionNumber: response.version.versionNumber,
        generation: prepared.generation,
        revision: prepared.revision,
      };
      setPublicationReceipt(receipt);
      void queryClient.invalidateQueries({
        queryKey: workflowPublishKeys.latestVersion(
          userId,
          workspaceId,
          workflowId,
        ),
      });
      onPublicationAccepted?.();
      return { kind: 'published', receipt };
    } catch (error) {
      if (owner.current !== publishOwner) return failed;
      if (dispatched && !isUncertainOutcome(error))
        publishAttempt.current = undefined;
      setPublishRecoveryPending(publishAttempt.current !== undefined);
      recordValidationCooldown(error);
      setPublishError(commandErrorMessage(error, 'publishing'));
      return failed;
    } finally {
      if (owner.current === publishOwner) setPublishStage(undefined);
    }
  }

  return {
    validation,
    validationPending,
    validationError,
    validationBlockedUntil,
    publicationReceipt,
    publishStage,
    publishPending: publishStage !== undefined,
    publishError,
    publishRecoveryPending,
    clearPublishError: () => {
      setPublishError(undefined);
    },
    validate,
    publish,
  };
}

export type WorkflowPublication = ReturnType<typeof useWorkflowPublication>;
