import { useState } from 'react';
import type {
  ApiProblemIssue,
  ConnectionFormDefinition,
} from '@pertexo/contracts';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import type { ConnectionCredential } from '../../data/connections.api';
import {
  credentialErrors,
  credentialServerErrors,
  emptyCredentialDraft,
  toConnectionCredential,
  type CredentialDraft,
  type CredentialField,
} from '../../model/credential-draft';

// The first header row needs a stable identity before anyone edits it.
const FIRST_ROW_ID = 'first';

export function createHeaderRowId(): string {
  return crypto.randomUUID();
}

/**
 * Owns one provider's unsaved credential and its validation. The secret stays
 * in this component's state only and is dropped by `clear`.
 */
export function useCredentialForm(
  definition: ConnectionFormDefinition | undefined,
  initial?: CredentialDraft,
) {
  const [stored, setStored] =
    useState<Readonly<{ authType: string; draft: CredentialDraft }>>();
  const validation = useFieldValidation<CredentialField>();
  let draft: CredentialDraft | undefined;
  if (definition !== undefined) {
    draft =
      stored?.authType === definition.authType
        ? stored.draft
        : (initial ?? emptyCredentialDraft(definition, () => FIRST_ROW_ID));
  }

  return {
    draft,
    validation,
    setDraft: (next: CredentialDraft) => {
      if (definition !== undefined)
        setStored({ authType: definition.authType, draft: next });
    },
    /** The credential to send, or undefined after focusing the first problem. */
    validate: (): ConnectionCredential | undefined =>
      draft !== undefined && validation.submit(credentialErrors(draft))
        ? toConnectionCredential(draft)
        : undefined,
    showServerIssues: (issues: readonly ApiProblemIssue[]) => {
      if (draft === undefined) return false;
      const errors = credentialServerErrors(draft, issues);
      if (Object.keys(errors).length === 0) return false;
      validation.showErrors(errors);
      return true;
    },
    clear: () => {
      setStored(undefined);
      validation.reset();
    },
  } as const;
}

export type CredentialForm = ReturnType<typeof useCredentialForm>;
