import { useRef, useState } from 'react';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import type { RenameFormProps } from './contract';

/**
 * What both rename forms share: the draft, its validation, the revision the
 * edit started from and how a save, a conflict or a retry settles.
 */
export function useRenameDraft({
  name,
  revision,
  validate,
  command,
  onSave,
  onClose,
}: RenameFormProps['value'] &
  Pick<RenameFormProps['field'], 'validate'> &
  Pick<RenameFormProps, 'command' | 'onSave'> &
  Readonly<{
    /** `true` when the rename was saved, `false` when it was let go. */
    onClose: (saved: boolean) => void;
  }>) {
  const [startedAs] = useState(name);
  // The revision people last saw: where the edit started, or the newer one
  // they chose to replace with "Keep mine". A background refresh never moves it.
  // The revision the next save starts from; handlers read it, nothing draws it.
  const baseRevision = useRef(revision);
  const [submittedRevision, setSubmittedRevision] = useState<number>();
  const [draft, setDraft] = useState(name);
  const validation = useFieldValidation<'name'>();

  /** A confirmed rename closes the form; anything else keeps it open. */
  function settle(confirmed: Promise<boolean> | undefined) {
    void confirmed?.then((done) => {
      if (done) onClose(true);
    });
  }

  function close() {
    command.dismiss();
    command.clearError();
    onClose(false);
  }

  function save(expectedRevision: number) {
    if (!validation.submit({ name: validate(draft) })) return;
    const trimmed = draft.trim();
    if (trimmed === name && expectedRevision === revision) {
      close();
      return;
    }
    setDraft(trimmed);
    baseRevision.current = expectedRevision;
    setSubmittedRevision(expectedRevision);
    settle(onSave(trimmed, expectedRevision));
  }

  const accepted = command.accepted ?? false;
  const conflict = command.error?.kind === 'conflict';
  const latestLoaded =
    conflict &&
    submittedRevision !== undefined &&
    revision !== submittedRevision;
  const locked = command.pending || command.retryAvailable || accepted;
  return {
    draft,
    validation,
    accepted,
    conflict,
    latestLoaded,
    locked,
    startedAs,
    close,
    change: (next: string) => {
      setDraft(next);
      command.clearError();
      validation.change('name', validate(next));
    },
    submit: () => {
      if (command.retryAvailable) settle(command.retry());
      else if (accepted) settle(command.refresh?.());
      else save(baseRevision.current);
    },
    keepMine: () => {
      command.clearError();
      save(revision);
    },
  };
}
