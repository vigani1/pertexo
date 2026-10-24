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
import type { InvitationCommand } from '../../data/mutations/use-invitation-command';
import { RoleSelectWithSummaries } from '../members/role-select';
import { EmailChipsField } from './email-chips-field';
import { InviteResults } from './invite-results';
import { useInviteBatch } from './use-invite-batch';

/**
 * Invite several people at once, as chips, with the role they start with.
 * Each address gets its own result as the invitations go out.
 */
type InvitePeopleSheetProps = Readonly<{
  open: boolean;
  roles: readonly ManagedRole[];
  command: InvitationCommand;
  onClose: () => void;
}>;

export function InvitePeopleSheet(props: InvitePeopleSheetProps) {
  const model = useInvitationForm(props);
  return (
    <Sheet
      open={model.open}
      onOpenChange={(next) => {
        if (!next) model.close();
      }}
    >
      <SheetContent className="w-[min(28rem,calc(100vw-1.5rem))]">
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            model.submit();
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
            {model.batch.rows === undefined ? (
              <FieldGroup>
                <EmailChipsField
                  id={`${model.id}-emails`}
                  emails={model.emails}
                  draft={model.draft}
                  disabled={model.command.locked}
                  error={model.validation.error('emails')}
                  inputRef={model.validation.register('emails')}
                  onDraftChange={(next) => {
                    model.setDraft(next);
                    if (model.validation.error('emails') !== undefined)
                      model.validation.change('emails', undefined);
                  }}
                  onCommit={model.commit}
                  onRemove={(email) => {
                    model.setEmails(
                      model.emails.filter((candidate) => candidate !== email),
                    );
                  }}
                />
                <LabelledField
                  id={`${model.id}-role`}
                  label="Role"
                  description="You can change it later from the Members tab."
                >
                  {(control) => (
                    <RoleSelectWithSummaries
                      value={model.role}
                      roles={model.roles}
                      disabled={model.command.locked}
                      onChange={model.setRole}
                      triggerProps={control}
                    />
                  )}
                </LabelledField>
              </FieldGroup>
            ) : (
              <InviteResults
                rows={model.batch.rows}
                busy={model.batch.sending || model.command.pending}
                onRetry={() => void model.batch.retryPaused()}
                onSkip={model.batch.skipPaused}
              />
            )}
          </SheetBody>
          <SheetFooter>
            {model.batch.rows === undefined ? (
              <>
                <Button type="button" variant="ghost" onClick={model.close}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={model.command.locked}
                >
                  {model.pendingCount > 1
                    ? `Send ${String(model.pendingCount)} invitations`
                    : 'Send invitation'}
                </Button>
              </>
            ) : (
              <>
                {/* Addresses that weren't sent go back into the form. */}
                {model.failedEmails.length > 0 && !model.batch.sending ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={model.command.locked}
                    onClick={() => {
                      model.setEmails(model.failedEmails);
                      model.setDraft('');
                      model.batch.reset();
                      model.validation.reset();
                    }}
                  >
                    Back to edit
                  </Button>
                ) : null}
                <ProgressButton
                  type="button"
                  variant="primary"
                  pending={model.batch.sending}
                  pendingLabel="Sending…"
                  disabled={model.command.locked}
                  onClick={model.close}
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

function useInvitationForm({
  open,
  roles,
  command,
  onClose,
}: InvitePeopleSheetProps) {
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

  return {
    open,
    close,
    submit,
    batch,
    id,
    emails,
    draft,
    command,
    validation,
    setDraft,
    commit,
    setEmails,
    role,
    roles,
    setRole,
    pendingCount,
    failedEmails,
  } as const;
}
