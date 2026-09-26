import { useId, useState } from 'react';
import { ProgressButton } from '@/components/ui/progress-button';
import { Button } from '@/components/ui/button';
import { FieldGroup, LabelledField } from '@/components/ui/field';
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
import { absorbAddresses } from '../../model/invite-addresses';
import type { ManagedRole } from '../../model/workspace-roles';
import type { InvitationCommand } from '../../mutations/use-invitation-command';
import { RoleSelectWithSummaries } from '../members/role-select';
import { EmailChipsField } from './email-chips-field';
import { InviteResults } from './invite-results';
import { useInviteBatch } from '../../use-invite-batch';

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
  const [role, setRole] = useState<ManagedRole>(() => roles.at(-1) ?? 'viewer');
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
  const failedEmails =
    batch.rows
      ?.filter((row) => row.delivery === 'failed')
      .map((row) => row.email) ?? [];

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
    validation.report('emails', absorbed.error);
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
              Each person gets an email with their own link, and signs in with
              the address you enter here.
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
                <LabelledField
                  id={`${id}-role`}
                  label="Role"
                  description="You can change it later from the Members tab."
                >
                  {(control) => (
                    <RoleSelectWithSummaries
                      value={role}
                      roles={roles}
                      disabled={command.locked}
                      onChange={setRole}
                      triggerProps={control}
                    />
                  )}
                </LabelledField>
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
              <>
                {/* Addresses that weren't sent go back into the form. */}
                {failedEmails.length > 0 && !batch.sending ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={command.locked}
                    onClick={() => {
                      setEmails(failedEmails);
                      setDraft('');
                      batch.reset();
                      validation.reset();
                    }}
                  >
                    Back to edit
                  </Button>
                ) : null}
                <ProgressButton
                  type="button"
                  variant="primary"
                  pending={batch.sending}
                  pendingLabel="Sending…"
                  disabled={command.locked}
                  onClick={close}
                >
                  Done
                </ProgressButton>
              </>
            )}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
