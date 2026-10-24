import { useId } from 'react';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { RenameFormProps } from './contract';
import { useRenameDraft } from './use-draft';
import { RenameOutcome, SaveActions } from './outcome';

/**
 * The rename form: the field, then Save and Cancel. Save sends the revision
 * the edit started from; if someone renamed it meanwhile, people choose
 * between their name and the newer one ("Use theirs / Keep mine"). A
 * confirmed rename, Cancel and Escape all call `onClose`.
 */
export function RenameForm({
  name,
  subject,
  label,
  command,
  onClose,
  className,
  ...rest
}: RenameFormProps & Readonly<{ onClose: () => void }>) {
  const id = useId();
  const rename = useRenameDraft({ name, command, onClose, ...rest });
  return (
    <form
      noValidate
      className={cn('flex max-w-xl min-w-0 flex-col gap-3', className)}
      onSubmit={(event) => {
        event.preventDefault();
        rename.submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !rename.locked) rename.close();
      }}
    >
      <LabelledField
        id={`${id}-name`}
        label={label}
        error={rename.validation.error('name')}
      >
        {(control) => (
          <Input
            {...control}
            ref={rename.validation.register('name')}
            autoComplete="off"
            autoFocus
            maxLength={128}
            value={rename.draft}
            disabled={rename.locked}
            onChange={(event) => {
              rename.change(event.currentTarget.value);
            }}
          />
        )}
      </LabelledField>
      <RenameOutcome
        name={name}
        subject={subject}
        command={command}
        rename={rename}
      />
      {rename.conflict ? null : (
        <SaveActions
          accepted={rename.accepted}
          pending={command.pending}
          refreshPending={command.refreshPending ?? false}
          retryAvailable={command.retryAvailable}
          onCancel={rename.close}
        />
      )}
    </form>
  );
}
