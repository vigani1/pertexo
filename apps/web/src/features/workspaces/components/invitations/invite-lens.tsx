import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { LoadingOrb } from '@/components/ui/loading-orb';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import { ValidatedField } from '@/components/ui/validated-field';
import { absorbAddresses } from '../../model/invite-addresses';
import type { ManagedRole } from '../../model/workspace-roles';
import type { InvitationCommand } from '../../mutations/use-invitation-command';
import { RoleSelect } from '../members/role-select';
import { EmailChipsField } from './email-chips-field';
import { InviteResults } from './invite-results';
import { useInviteBatch } from './use-invite-batch';

/**
 * Invite several people at once, as chips, with the role they start with.
 * Each address gets its own result as the invitations go out.
 */
export function InviteLens({
  open,
  roles,
  command,
  onClose,
}: Readonly<{
  open: boolean;
  roles: readonly ManagedRole[];
  command: InvitationCommand;
  onClose: () => void;
}>) {
  const id = useId();
  const notifications = useNotifications();
  const [emails, setEmails] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState('');
  const [role, setRole] = useState<ManagedRole>(roles.at(-1) ?? 'viewer');
  const validation = useFieldValidation<'emails'>();
  const batch = useInviteBatch(command, (sent) => {
    notifications.success({
      title:
        sent.length === 1
          ? `Invitation sent to ${sent[0] ?? ''}`
          : `Invited ${String(sent.length)} people`,
    });
    reset();
    onClose();
  });
  const pendingCount = emails.length + (draft.trim() === '' ? 0 : 1);

  function reset() {
    setEmails([]);
    setDraft('');
    batch.reset();
    validation.reset();
  }

  function close() {
    if (command.locked || batch.sending) return;
    reset();
    onClose();
  }

  function commit(text: string) {
    const absorbed = absorbAddresses(emails, text);
    setEmails(absorbed.emails);
    setDraft(absorbed.rest);
    if (absorbed.error === undefined) validation.change('emails', undefined);
    else validation.blur('emails', absorbed.error);
  }

  function submit() {
    const absorbed = absorbAddresses(emails, draft);
    setEmails(absorbed.emails);
    setDraft(absorbed.rest);
    const error =
      absorbed.error ??
      (absorbed.emails.length === 0
        ? 'Add at least one email address.'
        : undefined);
    if (validation.submit({ emails: error }))
      batch.start(absorbed.emails, role);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent className="w-[min(28rem,calc(100vw-1.5rem))]">
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <SheetHeader>
            <SheetTitle>Invite people</SheetTitle>
            <SheetDescription>
              They sign in with the address you enter here. Accepting signs them
              out of older sessions so they start with the new role.
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-5">
            {batch.rows === undefined ? (
              <FieldGroup>
                <EmailChipsField
                  id={`${id}-emails`}
                  emails={emails}
                  draft={draft}
                  disabled={command.locked}
                  error={validation.error('emails')}
                  thread={validation.thread('emails')}
                  inputRef={validation.register('emails')}
                  onDraftChange={(next) => {
                    setDraft(next);
                    if (validation.error('emails') !== undefined)
                      validation.change('emails', undefined);
                  }}
                  onCommit={commit}
                  onRemove={(email) => {
                    setEmails(
                      emails.filter((candidate) => candidate !== email),
                    );
                  }}
                />
                <ValidatedField
                  id={`${id}-role`}
                  label="Role"
                  description="You can change it later from the Members tab."
                >
                  {(control) => (
                    <RoleSelect
                      value={role}
                      roles={roles}
                      withSummaries
                      disabled={command.locked}
                      onChange={setRole}
                      triggerProps={control}
                    />
                  )}
                </ValidatedField>
              </FieldGroup>
            ) : (
              <InviteResults
                rows={batch.rows}
                busy={batch.sending || command.pending}
                onRetry={() => void batch.retryPaused()}
                onSkip={batch.skipPaused}
              />
            )}
          </SheetBody>
          <SheetFooter>
            {batch.rows === undefined ? (
              <>
                <Button type="button" variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={command.locked}
                >
                  {pendingCount > 1
                    ? `Send ${String(pendingCount)} invitations`
                    : 'Send invitation'}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="primary"
                disabled={batch.sending || command.locked}
                onClick={close}
              >
                {batch.sending ? <LoadingOrb data-icon="inline-start" /> : null}
                {batch.sending ? 'Sending…' : 'Done'}
              </Button>
            )}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
