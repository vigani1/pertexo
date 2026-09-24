import { useState } from 'react';
import type { ApiProblemIssue } from '@pertexo/contracts/schemas/errors';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import type { ConnectionCredential } from './connections.api';
import type { ProviderKey } from './model/connection-providers';
import {
  credentialErrors,
  credentialServerErrors,
  emptyCredentialDraft,
  toConnectionCredential,
  type CredentialDraft,
  type CredentialField,
} from './model/credential-draft';

// The first header row needs a stable identity before anyone edits it.
const FIRST_ROW_ID = 'first';

export function createHeaderRowId(): string {
  return crypto.randomUUID();
}

/**
 * Owns one provider's unsaved credential and its validation. The secret stays
 * in this component's state only and is dropped by `clear`.
 */
export function useCredentialForm(provider: ProviderKey) {
  const [stored, setDraft] = useState<CredentialDraft | undefined>();
  const validation = useFieldValidation<CredentialField>();
  const draft =
    stored?.provider === provider
      ? stored
      : emptyCredentialDraft(provider, () => FIRST_ROW_ID);

  return {
    draft,
    validation,
    setDraft,
    /** The credential to send, or undefined after focusing the first problem. */
    validate: (): ConnectionCredential | undefined =>
      validation.submit(credentialErrors(draft))
        ? toConnectionCredential(draft)
        : undefined,
    showServerIssues: (issues: readonly ApiProblemIssue[]) => {
      const errors = credentialServerErrors(draft, issues);
      if (Object.keys(errors).length === 0) return false;
      validation.showErrors(errors);
      return true;
    },
    clear: () => {
      setDraft(undefined);
      validation.reset();
    },
  } as const;
}

export type CredentialForm = ReturnType<typeof useCredentialForm>;
