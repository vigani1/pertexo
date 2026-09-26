import type { WorkflowValidateResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { retryAfterSeconds } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { publishWorkflow, validateWorkflow } from '../workflow-publish.api';
import { workflowPublishKeys } from '../workflow-publish.queries';
import { commandErrorMessage, isUncertainCommandError } from './command-utils';

export type ValidationResult = Readonly<{
  report: WorkflowValidateResponse;
  generation: number;
  revision: number;
}>;

type SavedDraft = Readonly<{
  etag: string;
  generation: number;
  revision: number;
}>;

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
  onPublicationAccepted,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  verifyIdentity: () => Promise<void>;
  ensureSaved: () => Promise<SavedDraft>;
  onPublicationAccepted?: () => void;
}>) {
  const queryClient = useQueryClient();
  const [validation, setValidation] = useState<ValidationResult>();
  // The check in flight, if any: it clears only its own marker, so a check
  // from an earlier scope can't end a newer one's wait.
  const [checking, setChecking] = useState<symbol>();
  const validationPending = checking !== undefined;
  const [validationError, setValidationError] = useState<string>();
  const [validationBlockedUntil, setValidationBlockedUntil] =
    useState<number>();
  const [publishStage, setPublishStage] = useState<PublishStage>();
  const [publishError, setPublishError] = useState<string>();
  const [publicationReceipt, setPublicationReceipt] =
    useState<PublicationReceipt>();
  const [publishRecoveryPending, setPublishRecoveryPending] = useState(false);
  const publishAttempt = useRef<PublishAttempt | undefined>(undefined);
  const validationInFlight =
    useRef<Promise<ValidationResult | undefined>>(undefined);
  const owner = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    const currentOwner = Symbol('workflow-publication');
    owner.current = currentOwner;
    return () => {
      if (owner.current === currentOwner) {
        owner.current = undefined;
        publishAttempt.current = undefined;
        validationInFlight.current = undefined;
      }
    };
  }, [apiClient, workspaceId, workflowId]);

  async function checkSavedDraft(
    saved: SavedDraft,
    checkOwner: symbol,
  ): Promise<ValidationResult | undefined> {
    const report = await validateWorkflow(apiClient, workspaceId, workflowId);
    if (owner.current !== checkOwner) return undefined;
    const result = {
      report,
      generation: saved.generation,
      revision: saved.revision,
    };
    setValidation(result);
    setValidationError(undefined);
    setValidationBlockedUntil(undefined);
    return result;
  }

  async function validate() {
    const checkOwner = owner.current;
    if (validationInFlight.current !== undefined || checkOwner === undefined)
      return;
    setChecking(checkOwner);
    setValidationError(undefined);
    const request = ensureSaved().then((saved) =>
      owner.current === checkOwner
        ? checkSavedDraft(saved, checkOwner)
        : undefined,
    );
    validationInFlight.current = request;
    try {
      await request;
    } catch (error) {
      if (owner.current !== checkOwner) return;
      const seconds = retryAfterSeconds(error);
      if (seconds !== undefined)
        setValidationBlockedUntil(Date.now() + seconds * 1_000);
      setValidationError(commandErrorMessage(error, 'checking for issues'));
    } finally {
      if (validationInFlight.current === request)
        validationInFlight.current = undefined;
      setChecking((current) => (current === checkOwner ? undefined : current));
    }
  }

  async function freshValidation(
    saved: SavedDraft,
    publishOwner: symbol,
  ): Promise<ValidationResult | undefined> {
    const inFlight = await validationInFlight.current?.catch(() => undefined);
    const known = inFlight ?? validation;
    if (
      known?.generation === saved.generation &&
      known.revision === saved.revision
    )
      return known;
    setPublishStage('checking');
    return checkSavedDraft(saved, publishOwner);
  }

  async function prepareAttempt(
    publishOwner: symbol,
  ): Promise<PublishAttempt | 'blocked' | undefined> {
    setPublishStage('saving');
    const saved = await ensureSaved();
    if (owner.current !== publishOwner) return undefined;
    const checked = await freshValidation(saved, publishOwner);
    if (owner.current !== publishOwner || checked === undefined)
      return undefined;
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
      const prepared =
        publishAttempt.current ?? (await prepareAttempt(publishOwner));
      if (prepared === undefined) return failed;
      if (prepared === 'blocked') return { kind: 'blocked' };
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
      if (dispatched && !isUncertainCommandError(error))
        publishAttempt.current = undefined;
      setPublishRecoveryPending(publishAttempt.current !== undefined);
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
