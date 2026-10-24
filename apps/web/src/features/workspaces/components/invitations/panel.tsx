import type {
  WorkspaceInvitation,
  WorkspaceInvitationsResponse,
} from '@pertexo/contracts';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { useState } from 'react';
import { LoadMore } from '@/components/patterns/lists/load-more';
import {
  FailedReadState,
  QueryView,
} from '@/components/patterns/states/query-view';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { useNotifications } from '@/components/ui/use-notifications';
import type { InvitationCommand } from '../../data/mutations/use-invitation-command';
import {
  InvitationActionDialog,
  type InvitationSelection,
} from './action-dialog';
import { InvitationList } from './list';

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
}: Readonly<{
  query: InvitationsQuery;
  invitations: readonly WorkspaceInvitation[];
  command: InvitationCommand;
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

  return (
    <div className="flex flex-col gap-3">
      <QueryView
        query={query}
        resource="Invitations"
        loading={<SkeletonRows label="Loading invitations" mark="avatar" />}
        error={(failed) => (
          <FailedReadState title="Invitations couldn’t be loaded" {...failed} />
        )}
      >
        {(data) =>
          invitations.length === 0 ? (
            <Empty>
              <EmptyTitle>No invitations yet</EmptyTitle>
              {/* Invite people sits in the page header already. */}
              <EmptyDescription>
                {data.pages[0]?.issuanceAvailable === false
                  ? 'Invitations will appear here when this server is configured to issue them.'
                  : 'Invite people by email and pick the role they start with.'}
              </EmptyDescription>
            </Empty>
          ) : (
            <InvitationList
              invitations={invitations}
              disabled={command.locked}
              issuanceAvailable={data.pages[0]?.issuanceAvailable ?? false}
              onAction={(invitation, action) => {
                if (command.locked) return;
                setFailure(undefined);
                setSelected({ invitation, action });
              }}
            />
          )
        }
      </QueryView>
      <LoadMore
        subject="invitations"
        label="Load more invitations"
        hasNextPage={query.hasNextPage}
        loading={query.isFetchingNextPage}
        failed={query.isFetchNextPageError}
        onLoadMore={() => void query.fetchNextPage()}
      />
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
