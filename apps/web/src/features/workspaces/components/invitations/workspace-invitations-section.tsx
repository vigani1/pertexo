import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkspaceInvitation,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { isUnauthenticated } from '@/features/auth/session-identity.public';
import { isApiError } from '@/lib/api/api-error';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import type { ApiClient } from '@/lib/api/client';
import { useInvitationCommand } from '../../mutations/use-invitation-command';
import { workspaceInvitationsInfiniteQueryOptions } from '../../workspaces.queries';
import { InviteMemberDialog } from './invite-member-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

export function WorkspaceInvitationsSection(
  props: Readonly<{
    apiClient: ApiClient;
    user: UserProfileResponse;
    workspace: AccessibleWorkspace;
    onAccessLost: (loss: 'authentication' | 'permission') => void;
  }>,
) {
  const { apiClient, user, workspace, onAccessLost } = props;
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<{
    invitation: WorkspaceInvitation;
    operation: 'resend' | 'revoke';
  }>();
  const query = useInfiniteQuery(
    workspaceInvitationsInfiniteQueryOptions(apiClient, user.id, workspace.id),
  );
  const command = useInvitationCommand({
    apiClient,
    userId: user.id,
    workspaceId: workspace.id,
    onAuthenticationLost: () => {
      onAccessLost('authentication');
    },
    onPermissionLost: () => {
      onAccessLost('permission');
    },
  });
  const invitations = query.data?.pages.flatMap((page) => page.items) ?? [];
  const authenticationLost = query.isError && isUnauthenticated(query.error);
  const permissionLost =
    query.isError &&
    isApiError(query.error) &&
    (query.error.status === 403 || query.error.status === 404);
  useEffect(() => {
    if (authenticationLost) onAccessLost('authentication');
    else if (permissionLost) onAccessLost('permission');
  }, [authenticationLost, onAccessLost, permissionLost]);
  const activeInvitation =
    command.activeAttempt?.kind === 'create'
      ? undefined
      : command.activeAttempt?.invitation;
  const dialogSelection =
    activeInvitation === undefined
      ? selected
      : {
          invitation: activeInvitation,
          operation: command.activeAttempt?.kind as 'resend' | 'revoke',
        };
  const createAttempt = command.activeAttempt?.kind === 'create';

  if (authenticationLost || permissionLost) return null;

  return (
    <section
      className="mt-12 border-t border-border pt-8"
      aria-labelledby="pending-invitations-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="pending-invitations-title" className="text-2xl font-semibold">
            Pending invitations
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Manage invitations and their latest delivery attempt.
          </p>
        </div>
        <Button
          type="button"
          disabled={command.locked}
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          Invite member
        </Button>
      </div>

      {query.isError &&
      invitations.length > 0 &&
      !query.isFetchNextPageError ? (
        <div
          role="alert"
          className="mt-5 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 px-4 py-3"
        >
          <p className="text-sm text-destructive">
            Invitations may be stale because refresh failed.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry refresh
          </Button>
        </div>
      ) : null}
      {query.isPending ? (
        <p role="status" className="py-10 text-sm text-muted-foreground">
          Loading invitations…
        </p>
      ) : query.isError && invitations.length === 0 ? (
        <Empty>
          <EmptyTitle>Invitations could not be loaded</EmptyTitle>
          <EmptyDescription>Try the request again.</EmptyDescription>
          <Button
            className="mt-5"
            type="button"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </Empty>
      ) : invitations.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
          No invitations have been created for this workspace.
        </p>
      ) : (
        <>
          <div className="mt-6 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-3">Recipient</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Delivery</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <tr key={invitation.id} className="border-t border-border">
                    <td className="max-w-xs break-all px-4 py-3">
                      {invitation.email}
                    </td>
                    <td className="px-4 py-3 capitalize">{invitation.role}</td>
                    <td className="px-4 py-3 capitalize">
                      {invitation.status}
                    </td>
                    <td className="px-4 py-3 capitalize">
                      {invitation.deliveryStatus}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {invitation.status === 'pending' ? (
                        <span className="inline-flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={command.locked}
                            onClick={() => {
                              setSelected({ invitation, operation: 'resend' });
                            }}
                          >
                            Resend
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={command.locked}
                            onClick={() => {
                              setSelected({ invitation, operation: 'revoke' });
                            }}
                          >
                            Revoke
                          </Button>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {query.hasNextPage ? (
            <div className="mt-5 flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => {
                  void query.fetchNextPage();
                }}
              >
                {query.isFetchingNextPage
                  ? 'Loading…'
                  : 'Load more invitations'}
              </Button>
            </div>
          ) : null}
          {query.isFetchNextPageError ? (
            <p
              role="alert"
              className="mt-4 text-center text-sm text-destructive"
            >
              The next invitation page could not be loaded. Try again.
            </p>
          ) : null}
        </>
      )}

      <InviteMemberDialog
        open={createOpen || createAttempt}
        allowedRoles={allowedRoles(workspace.role)}
        pending={command.pending}
        locked={command.locked}
        retryAvailable={command.retryAvailable && createAttempt}
        {...(command.message === undefined ? {} : { message: command.message })}
        onClose={() => {
          setCreateOpen(false);
        }}
        onInvite={command.create}
        onRetry={command.retry}
        onDismissUncertain={command.dismiss}
      />
      <InvitationActionDialog
        {...(dialogSelection === undefined
          ? {}
          : { selection: dialogSelection })}
        pending={command.pending}
        locked={command.locked}
        retryAvailable={command.retryAvailable && !createAttempt}
        {...(command.message === undefined ? {} : { message: command.message })}
        onClose={() => {
          setSelected(undefined);
        }}
        onConfirm={() =>
          dialogSelection === undefined
            ? Promise.resolve(false)
            : command.change(
                dialogSelection.invitation,
                dialogSelection.operation,
              )
        }
        onRetry={command.retry}
        onDismiss={command.dismiss}
      />
    </section>
  );
}

function InvitationActionDialog(
  props: Readonly<{
    selection?: {
      invitation: WorkspaceInvitation;
      operation: 'resend' | 'revoke';
    };
    pending: boolean;
    locked: boolean;
    retryAvailable: boolean;
    message?: string;
    onClose: () => void;
    onConfirm: () => Promise<boolean>;
    onRetry: () => Promise<boolean>;
    onDismiss: () => void;
  }>,
) {
  async function submit() {
    const accepted = await (props.retryAvailable
      ? props.onRetry()
      : props.onConfirm());
    if (accepted) props.onClose();
  }
  return (
    <Dialog
      open={props.selection !== undefined}
      onOpenChange={(open) => {
        if (!open && !props.locked) props.onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>
          {props.selection?.operation === 'revoke'
            ? 'Revoke invitation?'
            : 'Send a new invitation link?'}
        </DialogTitle>
        <DialogDescription>
          {props.selection?.operation === 'revoke'
            ? `The link for ${props.selection.invitation.email} will stop working.`
            : `The previous link for ${props.selection?.invitation.email ?? 'this recipient'} and any acceptance already in progress will stop working.`}
        </DialogDescription>
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
                props.onDismiss();
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
            onClick={() => {
              void submit();
            }}
          >
            {props.pending
              ? 'Working…'
              : props.retryAvailable
                ? 'Retry exact command'
                : props.selection?.operation === 'revoke'
                  ? 'Revoke'
                  : 'Resend'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const delegatedRoles = ['builder', 'operator', 'viewer'] as const;
function allowedRoles(role: AccessibleWorkspace['role']) {
  return role === 'owner'
    ? (['admin', ...delegatedRoles] as const)
    : delegatedRoles;
}
