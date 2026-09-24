import type {
  WorkspaceInvitation,
  WorkspaceInvitationsResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { useState } from 'react';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/ui/empty';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { useNotifications } from '@/components/ui/use-notifications';
import { describeReadError } from '@/lib/api/api-error-copy';
import type { InvitationCommand } from '../../mutations/use-invitation-command';
import {
  InvitationActionDialog,
  type InvitationSelection,
} from './invitation-action-dialog';
import { InvitationList } from './invitation-list';

type InvitationsQuery = UseInfiniteQueryResult<
  InfiniteData<WorkspaceInvitationsResponse>
>;

const DONE_TITLES = {
  resend: (email: string) => `Sent a new link to ${email}`,
  revoke: (email: string) => `Revoked the invitation for ${email}`,
} as const;

/** Invitations with their delivery and expiry; Resend and Revoke sit in ⋯. */
export function InvitationsPanel({
  query,
  invitations,
  command,
  onInvite,
}: Readonly<{
  query: InvitationsQuery;
  invitations: readonly WorkspaceInvitation[];
  command: InvitationCommand;
  onInvite: () => void;
}>) {
  const notifications = useNotifications();
  const [selected, setSelected] = useState<InvitationSelection>();
  const [failure, setFailure] = useState<string>();
  const active = command.activeAttempt;
  const selection: InvitationSelection | undefined =
    active === undefined || active.kind === 'create'
      ? selected
      : { invitation: active.invitation, action: active.kind };

  async function run(outcome: ReturnType<InvitationCommand['retry']>) {
    const result = await outcome;
    if (result.kind === 'failed') setFailure(result.message);
    if (result.kind !== 'done' || selection === undefined) return;
    notifications.success({
      title: DONE_TITLES[selection.action](selection.invitation.email),
    });
    setSelected(undefined);
  }

  if (query.isPending)
    return (
      <p role="status" className="py-8 text-sm text-muted-foreground">
        Loading invitations…
      </p>
    );
  if (query.isError && invitations.length === 0)
    return (
      <Empty>
        <EmptyTitle>Invitations couldn’t be loaded</EmptyTitle>
        <EmptyDescription>
          {describeReadError(query.error, 'Invitations')}
        </EmptyDescription>
        <EmptyActions>
          <Button
            type="button"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </EmptyActions>
      </Empty>
    );

  return (
    <div className="flex flex-col gap-3">
      {query.isError && !query.isFetchNextPageError ? (
        <StaleLine
          updatedAt={query.dataUpdatedAt}
          retrying={query.isRefetching}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {invitations.length === 0 ? (
        <Empty>
          <EmptyTitle>No invitations yet</EmptyTitle>
          <EmptyDescription>
            Invite people by email and pick the role they start with.
          </EmptyDescription>
          <EmptyActions>
            <Button type="button" variant="outline" onClick={onInvite}>
              Invite people
            </Button>
          </EmptyActions>
        </Empty>
      ) : (
        <InvitationList
          invitations={invitations}
          disabled={command.locked}
          onAction={(invitation, action) => {
            if (command.locked) return;
            setFailure(undefined);
            setSelected({ invitation, action });
          }}
        />
      )}
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          className="self-center"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? (
            <LoadingOrb data-icon="inline-start" />
          ) : null}
          {query.isFetchingNextPage ? 'Loading…' : 'Load more invitations'}
        </Button>
      ) : null}
      {query.isFetchNextPageError ? (
        <p role="alert" className="text-center text-sm text-destructive">
          More invitations couldn’t be loaded. Try again.
        </p>
      ) : null}
      <InvitationActionDialog
        selection={selection}
        pending={command.pending}
        locked={command.locked}
        retryAvailable={command.retryAvailable && active?.kind !== 'create'}
        message={
          active !== undefined && active.kind !== 'create'
            ? command.message
            : failure
        }
        onClose={() => {
          setSelected(undefined);
        }}
        onConfirm={() => {
          if (selection !== undefined)
            void run(command.change(selection.invitation, selection.action));
        }}
        onRetry={() => {
          void run(command.retry());
        }}
        onDismiss={command.dismiss}
      />
    </div>
  );
}
