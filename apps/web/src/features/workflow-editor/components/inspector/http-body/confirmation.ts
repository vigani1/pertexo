import { useState } from 'react';

type BodyChange = Readonly<{
  apply: () => void;
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
}>;

/**
 * Body changes that replace something people filled in wait for a
 * confirmation, which lapses once the body changes underneath it. The rest
 * apply at once.
 */
export function useBodyConfirmation(signature: string) {
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const pending =
    confirmation?.signature === signature ? confirmation : undefined;

  function request({
    apply,
    destructive,
    title,
    description,
    confirmLabel = 'Replace',
  }: BodyChange) {
    if (destructive)
      setConfirmation({ signature, title, description, confirmLabel, apply });
    else apply();
  }

  return {
    pending,
    request,
    /** Applies the pending change, unless the body moved on meanwhile. */
    confirm: (stillCurrent: boolean) => {
      if (stillCurrent) pending?.apply();
      setConfirmation(undefined);
    },
    dismiss: () => {
      setConfirmation(undefined);
    },
  } as const;
}
