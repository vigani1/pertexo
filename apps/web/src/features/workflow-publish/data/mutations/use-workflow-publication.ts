import {
  RETRY_WINDOW_ENDED,
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/contract';
import type { PublicationReview } from '@pertexo/contracts';
import { requestPublicationReview } from '../reviews/api';
import { publicationReviewKeys } from '../reviews/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { publishWorkflow } from '../workflow-publish.api';
import { workflowPublishKeys } from '../workflow-publish.queries';
import { commandErrorMessage } from './command-utils';
import {
  useWorkflowDraftValidation,
  type SavedDraft,
} from './use-workflow-draft-validation';

type PublicationCommand =
  Readonly<{ kind: 'publish' }> | Readonly<{ kind: 'review'; note: string }>;
type PublishAttempt = SavedDraft &
  Readonly<{ command: PublicationCommand }> &
  CommandKey;

export type PublicationReceipt = SavedDraft &
  Readonly<{
    versionId: string;
    versionNumber: number;
    reused: boolean;
  }>;

export type PublishStage = 'saving' | 'checking' | 'publishing';
export type PublishResult =
  | Readonly<{ kind: 'published'; receipt: PublicationReceipt }>
  | Readonly<{ kind: 'review_requested'; request: PublicationReview }>
  | Readonly<{ kind: 'blocked' | 'failed' }>;

const failed: PublishResult = { kind: 'failed' };

/**
 * Validation and publication of the saved draft. Publishing saves, checks the
 * exact saved revision (reusing a fresh report) and only then sends one
 * keyed command; an uncertain outcome keeps that command for an exact retry.
 */
type PublicationOptions = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  verifyIdentity: () => Promise<void>;
  ensureSaved: () => Promise<SavedDraft>;
  isSavedDraftCurrent: (saved: SavedDraft) => boolean;
  onPublicationAccepted?: () => void;
}>;

export function useWorkflowPublication({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  verifyIdentity,
  ensureSaved,
  isSavedDraftCurrent,
  onPublicationAccepted,
}: PublicationOptions) {
  const queryClient = useQueryClient();
  const [publishStage, setPublishStage] = useState<PublishStage>();
  const [publishError, setPublishError] = useState<string>();
  const [publicationReceipt, setPublicationReceipt] =
    useState<PublicationReceipt>();
  const [publishRecoveryPending, setPublishRecoveryPending] = useState(false);
  const [recoveryCommand, setRecoveryCommand] =
    useState<PublicationCommand['kind']>();
  const publishAttempt = useRef<PublishAttempt | undefined>(undefined);
  const owner = useRef<symbol | undefined>(undefined);
  const draftValidation = useWorkflowDraftValidation({
    apiClient,
    workspaceId,
    workflowId,
    owner,
    ensureSaved,
    isSavedDraftCurrent,
  });
  const scope = { apiClient, userId, workspaceId };
  const { resetValidation } = draftValidation;
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

  async function publish(
    command: PublicationCommand = { kind: 'publish' },
  ): Promise<PublishResult> {
    const publishOwner = owner.current;
    if (publishStage !== undefined || publishOwner === undefined) return failed;
    if (
      publishAttempt.current !== undefined &&
      !canResend(publishAttempt.current)
    ) {
      publishAttempt.current = undefined;
      setPublishRecoveryPending(false);
      setRecoveryCommand(undefined);
      setPublishError(RETRY_WINDOW_ENDED);
      return failed;
    }
    let dispatched = false;
    setPublishError(undefined);
    try {
      setPublishStage('saving');
      await verifyIdentity();
      if (owner.current !== publishOwner) return failed;
      if (publishAttempt.current === undefined)
        draftValidation.assertValidationAvailable();
      const prepared =
        publishAttempt.current ??
        (await preparePublicationAttempt(
          {
            owner,
            ensureSaved,
            freshValidation: draftValidation.freshValidation,
            isSavedDraftCurrent,
            setPublishStage,
            setPublishError,
          },
          publishOwner,
          command,
        ));
      if (prepared === undefined) return failed;
      if (prepared === 'blocked') return { kind: 'blocked' };
      if (owner.current !== publishOwner) return failed;
      if (publishAttempt.current === undefined)
        draftValidation.assertValidationAvailable();
      if (
        newPublicationDraftChanged(
          publishAttempt.current,
          prepared,
          isSavedDraftCurrent,
        )
      ) {
        setPublishError(
          'Your draft changed during the check. Review your changes and try again.',
        );
        return { kind: 'blocked' };
      }
      publishAttempt.current = prepared;
      dispatched = true;
      setPublishStage('publishing');
      const result = await dispatchPublication(scope, workflowId, prepared);
      if (owner.current !== publishOwner) return failed;
      publishAttempt.current = undefined;
      setPublishRecoveryPending(false);
      if (result.kind === 'review_requested') {
        void queryClient.invalidateQueries({
          queryKey: publicationReviewKeys.scope(scope),
        });
        return result;
      }
      const receipt = result.receipt;
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
      const failure = publicationFailure({
        error,
        dispatched,
        attempt: publishAttempt.current,
      });
      publishAttempt.current = failure.attempt;
      setPublishRecoveryPending(failure.attempt !== undefined);
      setRecoveryCommand(failure.attempt?.command.kind);
      if (failure.invalidateReviews)
        void queryClient.invalidateQueries({
          queryKey: publicationReviewKeys.scope(scope),
        });
      draftValidation.recordValidationCooldown(error);
      setPublishError(commandErrorMessage(error, 'publishing'));
      return failed;
    } finally {
      if (owner.current === publishOwner) setPublishStage(undefined);
    }
  }

  return {
    validation: draftValidation.validation,
    validationPending: draftValidation.validationPending,
    validationError: draftValidation.validationError,
    validationBlockedUntil: draftValidation.validationBlockedUntil,
    publicationReceipt,
    publishStage,
    publishPending: publishStage !== undefined,
    publishError,
    publishRecoveryPending,
    recoveryCommand,
    clearPublishError: () => {
      setPublishError(undefined);
    },
    validate: draftValidation.validate,
    publish,
  };
}

export type WorkflowPublication = ReturnType<typeof useWorkflowPublication>;

type PublicationPreparation = Readonly<{
  owner: Readonly<{ current: symbol | undefined }>;
  ensureSaved: () => Promise<SavedDraft>;
  freshValidation: ReturnType<
    typeof useWorkflowDraftValidation
  >['freshValidation'];
  isSavedDraftCurrent: (saved: SavedDraft) => boolean;
  setPublishStage: (stage: PublishStage) => void;
  setPublishError: (message: string) => void;
}>;
async function preparePublicationAttempt(
  {
    owner,
    ensureSaved,
    freshValidation,
    isSavedDraftCurrent,
    setPublishStage,
    setPublishError,
  }: PublicationPreparation,
  publishOwner: symbol,
  command: PublicationCommand,
): Promise<PublishAttempt | 'blocked' | undefined> {
  setPublishStage('saving');
  const saved = await ensureSaved();
  if (owner.current !== publishOwner) return undefined;
  const checked = await freshValidation(saved, publishOwner, () => {
    setPublishStage('checking');
  });
  if (owner.current !== publishOwner || checked === undefined) return undefined;
  if (checked.etag !== saved.etag || !isSavedDraftCurrent(saved)) {
    setPublishError(
      'This check describes a different draft. Review the latest changes and check again before publishing.',
    );
    return 'blocked';
  }
  if (!checked.report.valid) return 'blocked';
  const current = checked.report.currentPublication;
  if (current?.matchesDraft) {
    setPublishError(
      `No changes since v${String(current.versionNumber)}. This version is already live.`,
    );
    return 'blocked';
  }
  return { ...saved, ...newCommandKey(), command };
}

async function dispatchPublication(
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspaceId: string;
  }>,
  workflowId: string,
  prepared: PublishAttempt,
): Promise<Extract<PublishResult, { kind: 'published' | 'review_requested' }>> {
  if (prepared.command.kind === 'review') {
    const request = await requestPublicationReview(scope, workflowId, {
      etag: prepared.etag,
      idempotencyKey: prepared.idempotencyKey,
      note: prepared.command.note,
    });
    return { kind: 'review_requested', request };
  }
  const response = await publishWorkflow(
    scope.apiClient,
    scope.workspaceId,
    workflowId,
    { etag: prepared.etag, idempotencyKey: prepared.idempotencyKey },
  );
  return {
    kind: 'published',
    receipt: {
      versionId: response.version.id,
      versionNumber: response.version.versionNumber,
      reused: response.reused,
      etag: prepared.etag,
      generation: prepared.generation,
      revision: prepared.revision,
    },
  };
}

function publicationFailure({
  error,
  dispatched,
  attempt,
}: Readonly<{
  error: unknown;
  dispatched: boolean;
  attempt: PublishAttempt | undefined;
}>) {
  const invalidateReviews = dispatched && !isUnconfirmedCommand(error);
  return {
    attempt: invalidateReviews ? undefined : attempt,
    invalidateReviews,
  };
}

function newPublicationDraftChanged(
  attempt: PublishAttempt | undefined,
  prepared: PublishAttempt,
  isSavedDraftCurrent: PublicationOptions['isSavedDraftCurrent'],
) {
  return attempt === undefined && !isSavedDraftCurrent(prepared);
}
