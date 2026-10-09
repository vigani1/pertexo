import type { WorkflowValidateResponse } from '@pertexo/contracts';
import { useCallback, useRef, useState, type RefObject } from 'react';
import { retryAfterSeconds } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { useNow } from '@/lib/hooks/use-now';
import { validateWorkflow } from '../workflow-publish.api';
import { commandErrorMessage } from './command-utils';

export type ValidationResult = Readonly<{
  report: WorkflowValidateResponse;
  etag: string;
  requestedEtag: string;
  generation: number;
  revision: number;
}>;

export type SavedDraft = Readonly<{
  etag: string;
  generation: number;
  revision: number;
}>;

/**
 * Saved-snapshot validation, coalescing and server-directed cooldowns.
 * Publication's owner remains authoritative for all async completions.
 */
export function useWorkflowDraftValidation({
  apiClient,
  workspaceId,
  workflowId,
  owner,
  ensureSaved,
  isSavedDraftCurrent,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  owner: RefObject<symbol | undefined>;
  ensureSaved: () => Promise<SavedDraft>;
  isSavedDraftCurrent: (saved: SavedDraft) => boolean;
}>) {
  const [validation, setValidation] = useState<ValidationResult>();
  // The check in flight, if any: it clears only its own marker, so a check
  // from an earlier scope can't end a newer one's wait.
  const [checking, setChecking] = useState<symbol>();
  const validationPending = checking !== undefined;
  const [validationError, setValidationError] = useState<string>();
  const [validationBlockedUntil, setValidationBlockedUntil] =
    useState<number>();
  // Imperative dispatch must see deadlines established by concurrent actions,
  // even before React renders or after this callback crosses an await.
  const validationDeadline = useRef(0);
  const now = useNow(
    250,
    validationBlockedUntil !== undefined,
    validationBlockedUntil,
  );
  const validationInFlight =
    useRef<Promise<ValidationResult | undefined>>(undefined);
  const validationOwner = useRef<symbol | undefined>(undefined);
  const resetValidation = useCallback(() => {
    validationInFlight.current = undefined;
    validationOwner.current = undefined;
    validationDeadline.current = 0;
  }, []);

  async function checkSavedDraft(
    saved: SavedDraft,
    checkOwner: symbol,
  ): Promise<ValidationResult | undefined> {
    if (owner.current !== checkOwner) return undefined;
    assertValidationAvailable();
    const checked = await validateWorkflow(apiClient, workspaceId, workflowId);
    if (owner.current !== checkOwner) return undefined;
    const result = {
      ...checked,
      requestedEtag: saved.etag,
      generation: saved.generation,
      revision: saved.revision,
    };
    setValidation(result);
    validationOwner.current = checkOwner;
    setValidationError(undefined);
    return result;
  }

  async function validate() {
    const checkOwner = owner.current;
    if (
      validationInFlight.current !== undefined ||
      checkOwner === undefined ||
      (validationBlockedUntil ?? 0) > now
    )
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
      recordValidationCooldown(error);
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
    onChecking: () => void,
  ): Promise<ValidationResult | undefined> {
    // A failed shared check must not immediately start another request and
    // bypass its Retry-After window. The caller handles that same failure.
    const inFlight = await validationInFlight.current;
    if (owner.current !== publishOwner) return undefined;
    assertValidationAvailable();
    const known = inFlight ?? validation;
    if (
      known?.generation === saved.generation &&
      validationOwner.current === publishOwner &&
      known.revision === saved.revision &&
      known.etag === saved.etag &&
      known.requestedEtag === saved.etag &&
      isSavedDraftCurrent(saved)
    )
      return known;
    onChecking();
    return checkSavedDraft(saved, publishOwner);
  }

  function assertValidationAvailable() {
    if (validationDeadline.current > Date.now())
      throw new Error(
        'Checking is temporarily unavailable. Wait before trying again.',
      );
  }

  function recordValidationCooldown(error: unknown) {
    const seconds = retryAfterSeconds(error);
    const unavailable =
      isApiError(error) &&
      error.problem?.code === 'workflow.validation_unavailable';
    if (seconds !== undefined || unavailable) {
      const deadline = Date.now() + Math.max(5, seconds ?? 1) * 1_000;
      validationDeadline.current = Math.max(
        validationDeadline.current,
        deadline,
      );
      setValidationBlockedUntil(validationDeadline.current);
    }
  }

  return {
    validation,
    validationPending,
    validationError,
    validationBlockedUntil,
    validate,
    freshValidation,
    assertValidationAvailable,
    recordValidationCooldown,
    resetValidation,
  };
}
