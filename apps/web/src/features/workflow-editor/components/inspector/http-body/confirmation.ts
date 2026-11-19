import { useState } from 'react';
import { changeAndFocusFormPart } from './focus';

type BodyChange = Readonly<{
  apply: () => void;
  /** The control that takes focus once the change is applied. */
  focusId?: string | undefined;
  destructive: boolean;
  title: string;
  description: string;
  confirmLabel?: string | undefined;
}>;

type Confirmation = Readonly<{
  signature: string;
  title: string;
  description: string;
  confirmLabel: string;
  apply: () => void;
  focusId: string | undefined;
}>;

/**
 * Body changes that replace something people filled in wait for a
 * confirmation, which lapses once the body changes underneath it. The rest
 * apply at once.
 */
export function useBodyConfirmation(signature: string) {
  const [confirmation, setConfirmation] = useState<Confirmation>();
  // A confirmed change that moves focus hands it to the closing dialog:
  // focus set while the dialog is open would be taken back as it closes.
  const [focusAfterClose, setFocusAfterClose] = useState<string>();
  const pending =
    confirmation?.signature === signature ? confirmation : undefined;

  function request({
    apply,
    focusId,
    destructive,
    title,
    description,
    confirmLabel = 'Replace',
  }: BodyChange) {
    if (destructive) {
      setFocusAfterClose(undefined);
      setConfirmation({
        signature,
        title,
        description,
        confirmLabel,
        apply,
        focusId,
      });
    } else if (focusId === undefined) apply();
    else changeAndFocusFormPart(apply, focusId);
  }

  return {
    pending,
    request,
    /** Applies the pending change, unless the body moved on meanwhile. */
    confirm: (stillCurrent: boolean) => {
      if (stillCurrent && pending !== undefined) {
        pending.apply();
        setFocusAfterClose(pending.focusId);
      }
      setConfirmation(undefined);
    },
    dismiss: () => {
      setConfirmation(undefined);
    },
    finalFocus:
      focusAfterClose === undefined
        ? undefined
        : () => document.getElementById(focusAfterClose) ?? true,
  } as const;
}
