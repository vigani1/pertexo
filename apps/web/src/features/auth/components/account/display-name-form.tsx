import {
  USER_DISPLAY_NAME_MAX_LENGTH,
  userDisplayNameSchema,
  type UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { useDisplayNameChange } from '../../account-security.mutations';

/** What is wrong with a name and how to fix it, from the contract's rules. */
function nameProblem(value: string): string | undefined {
  if (userDisplayNameSchema.safeParse(value).success) return undefined;
  const name = value.trim();
  if (name.length === 0) return 'Enter the name teammates should see.';
  if (name.length > USER_DISPLAY_NAME_MAX_LENGTH)
    return `Use ${String(USER_DISPLAY_NAME_MAX_LENGTH)} characters or fewer.`;
  return 'Remove line breaks and tabs from the name.';
}

/**
 * Edits the display name in place. Save sends the revision the edit started
 * from; an unconfirmed save repeats exactly, and a newer name from elsewhere
 * is loaded with the edit kept open.
 */
export function DisplayNameForm({
  apiClient,
  user,
  onClose,
  onChanged,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  onClose: () => void;
  onChanged: () => void;
}>) {
  const id = useId();
  const notifications = useNotifications();
  const [name, setName] = useState(user.displayName);
  const validation = useFieldValidation<'name'>();
  const command = useDisplayNameChange({
    apiClient,
    onChanged: (profile) => {
      notifications.success({
        title: `Your name is now ${profile.displayName}`,
      });
      onChanged();
      onClose();
    },
    onReloaded: onChanged,
  });
  const locked = command.pending || command.unconfirmed;

  function submit() {
    if (command.unconfirmed) {
      command.retry();
      return;
    }
    if (!validation.submit({ name: nameProblem(name) })) return;
    const next = name.trim();
    if (next === user.displayName) onClose();
    else command.save(next, user.revision);
  }

  return (
    <form
      noValidate
      className="flex max-w-md flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !locked) onClose();
      }}
    >
      <LabelledField
        id={`${id}-display-name`}
        label="Your name"
        description="Teammates see it in every workspace you belong to."
        error={validation.error('name')}
        thread={validation.thread('name')}
      >
        {(control) => (
          <Input
            {...control}
            ref={validation.register('name')}
            autoComplete="name"
            autoFocus
            maxLength={USER_DISPLAY_NAME_MAX_LENGTH + 32}
            value={name}
            disabled={locked}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setName(next);
              validation.change('name', nameProblem(next));
            }}
            onBlur={() => {
              validation.blur('name', nameProblem(name));
            }}
          />
        )}
      </LabelledField>
      <NameOutcome command={command} latest={user.displayName} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={command.pending}
          onClick={() => {
            if (command.unconfirmed) command.dismiss();
            onClose();
          }}
        >
          Cancel
        </Button>
        <ProgressButton
          type="submit"
          variant="default"
          pending={command.pending}
          pendingLabel="Saving…"
        >
          {command.unconfirmed ? 'Try again' : 'Save'}
        </ProgressButton>
      </div>
    </form>
  );
}

function NameOutcome({
  command,
  latest,
}: Readonly<{
  command: ReturnType<typeof useDisplayNameChange>;
  latest: string;
}>) {
  if (command.unconfirmed)
    return (
      <Notice role="alert" tone="warning">
        We couldn’t confirm whether your name changed. Try again — Pertexo
        recognises the repeat, so it can’t apply twice.
      </Notice>
    );
  if (command.conflict)
    return (
      <Notice role="alert" tone="warning">
        Your name changed somewhere else and is now “{latest}”. Save again to
        replace it.
      </Notice>
    );
  if (command.failure === undefined) return null;
  return (
    <Notice role="alert" tone="destructive">
      {command.failure}
    </Notice>
  );
}
