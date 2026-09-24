import { workspaceInvitationCreateRequestSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

type ManagedRole = 'admin' | 'builder' | 'operator' | 'viewer';

export function InviteMemberDialog(
  props: Readonly<{
    open: boolean;
    allowedRoles: readonly ManagedRole[];
    pending: boolean;
    locked: boolean;
    retryAvailable: boolean;
    message?: string;
    onClose: () => void;
    onInvite: (email: string, role: ManagedRole) => Promise<boolean>;
    onRetry: () => Promise<boolean>;
    onDismissUncertain: () => void;
  }>,
) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ManagedRole>(
    props.allowedRoles.at(-1) ?? 'viewer',
  );
  const [emailError, setEmailError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  function validateEmail(value: string) {
    const valid =
      workspaceInvitationCreateRequestSchema.shape.email.safeParse(
        value,
      ).success;
    const message = valid
      ? undefined
      : 'Enter a valid recipient email address.';
    setEmailError(message);
    return valid;
  }

  async function submit() {
    if (props.retryAvailable) {
      const accepted = await props.onRetry();
      if (accepted) props.onClose();
      return;
    }
    setSubmitted(true);
    if (!validateEmail(email)) {
      emailRef.current?.focus();
      return;
    }
    const accepted = await props.onInvite(email.trim(), role);
    if (accepted) props.onClose();
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.locked) props.onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Invite a workspace member</DialogTitle>
        <DialogDescription>
          The invitation expires in seven days. The recipient must sign in with
          this verified address. Accepting new access signs them out of older
          Pertexo sessions so they can re-enter with the new permission.
        </DialogDescription>
        <label
          className="mt-5 block text-sm font-medium"
          htmlFor="invite-email"
        >
          Recipient email
        </label>
        <input
          ref={emailRef}
          id="invite-email"
          type="email"
          autoComplete="email"
          className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
          value={email}
          disabled={props.locked}
          aria-invalid={emailError === undefined ? undefined : true}
          aria-describedby={
            emailError === undefined ? undefined : 'invite-email-error'
          }
          onBlur={() => {
            validateEmail(email);
          }}
          onChange={(event) => {
            const next = event.target.value;
            setEmail(next);
            if (submitted || emailError !== undefined) validateEmail(next);
          }}
        />
        {emailError === undefined ? null : (
          <p id="invite-email-error" className="mt-2 text-sm text-destructive">
            {emailError}
          </p>
        )}
        <label className="mt-5 block text-sm font-medium" htmlFor="invite-role">
          Workspace role
        </label>
        <select
          id="invite-role"
          className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
          value={role}
          disabled={props.locked}
          onChange={(event) => {
            setRole(event.target.value as ManagedRole);
          }}
        >
          {props.allowedRoles.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
        {props.message === undefined ? null : (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {props.message}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          {props.retryAvailable ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                props.onDismissUncertain();
                props.onClose();
              }}
            >
              Dismiss attempt
            </Button>
          ) : (
            <DialogClose
              disabled={props.locked}
              render={<Button type="button" variant="ghost" />}
            >
              Cancel
            </DialogClose>
          )}
          <Button
            type="button"
            disabled={props.pending}
            onClick={() => void submit()}
          >
            {props.pending
              ? 'Sending…'
              : props.retryAvailable
                ? 'Retry same invitation'
                : 'Send invitation'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
