import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
import {
  ROLE_SUMMARIES,
  withArticle,
  type ManagedRole,
} from '../../model/workspace-roles';

/**
 * Confirms a role change. The person is signed out everywhere so their next
 * sign-in carries the new role; that is said before anything is sent.
 */
export function MemberRoleDialog(
  props: Readonly<{
    change:
      Readonly<{ member: WorkspaceMember; role: ManagedRole }> | undefined;
    pending: boolean;
    locked: boolean;
    retryAvailable: boolean;
    error: string | undefined;
    onClose: () => void;
    onConfirm: () => void;
    onRetry: () => void;
    onDismissUncertain: () => void;
  }>,
) {
  const { change } = props;
  const firstName = change?.member.displayName.split(/\s+/u)[0] ?? 'They';
  return (
    <Dialog
      open={change !== undefined}
      onOpenChange={(open) => {
        if (!open && !props.locked) props.onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>
          Make {change?.member.displayName ?? 'this member'}{' '}
          {change === undefined ? 'a new role' : withArticle(change.role)}?
        </DialogTitle>
        <DialogDescription>
          {change === undefined ? null : ROLE_SUMMARIES[change.role]}{' '}
          {firstName} will be signed out everywhere and signs in again with the
          new role.
        </DialogDescription>
        {props.error === undefined ? null : (
          <Notice
            role="alert"
            tone={props.retryAvailable ? 'warning' : 'destructive'}
            className="mt-5"
          >
            {props.error}
          </Notice>
        )}
        <div className="mt-6 flex justify-end gap-2">
          {props.retryAvailable ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                props.onDismissUncertain();
                props.onClose();
              }}
            >
              Close
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
            variant="primary"
            disabled={props.pending || change === undefined}
            onClick={props.retryAvailable ? props.onRetry : props.onConfirm}
          >
            {props.pending ? <LoadingOrb data-icon="inline-start" /> : null}
            {props.pending
              ? 'Changing…'
              : props.retryAvailable
                ? 'Try again'
                : 'Change role'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
