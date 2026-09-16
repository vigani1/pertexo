import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

type ManagedRole = 'admin' | 'builder' | 'operator' | 'viewer';

export function MemberRoleDialog(
  props: Readonly<{
    member?: WorkspaceMember;
    allowedRoles: readonly ManagedRole[];
    pending: boolean;
    locked: boolean;
    retryAvailable: boolean;
    error?: string;
    onClose: () => void;
    onChange: (role: ManagedRole) => Promise<boolean>;
    onRetry: () => Promise<boolean>;
    onDismissUncertain: () => void;
  }>,
) {
  const [role, setRole] = useState<ManagedRole | undefined>();
  const selectedRole =
    role ?? (props.member?.role === 'owner' ? undefined : props.member?.role);

  async function submit() {
    if (selectedRole === undefined) return;
    const accepted = await (props.retryAvailable
      ? props.onRetry()
      : props.onChange(selectedRole));
    if (accepted) props.onClose();
  }

  return (
    <Dialog
      open={props.member !== undefined}
      onOpenChange={(open) => {
        if (!open && !props.locked) props.onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Change member role?</DialogTitle>
        <DialogDescription>
          Change {props.member?.displayName ?? 'this member'}’s workspace role.
          Their active Pertexo sessions will be revoked, so they must sign in
          again.
        </DialogDescription>
        <label className="mt-5 block text-sm font-medium" htmlFor="member-role">
          New role
        </label>
        <select
          id="member-role"
          className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={selectedRole ?? ''}
          disabled={props.pending || props.retryAvailable}
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
        {props.error === undefined ? null : (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {props.error}
          </p>
        )}
        {props.retryAvailable ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Retry sends the exact original role, revision, and command key.
          </p>
        ) : null}
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
              render={
                <Button type="button" variant="ghost" disabled={props.locked} />
              }
            >
              Cancel
            </DialogClose>
          )}
          <Button
            type="button"
            disabled={
              props.pending ||
              selectedRole === undefined ||
              (!props.retryAvailable && selectedRole === props.member?.role)
            }
            onClick={() => void submit()}
          >
            {props.pending
              ? 'Changing…'
              : props.retryAvailable
                ? 'Retry same change'
                : 'Change role'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
