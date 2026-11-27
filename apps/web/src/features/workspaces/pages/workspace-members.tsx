import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { UnavailablePage } from '@/components/patterns/states/unavailable-page';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { SearchInput } from '@/components/ui/input';
import { Disclosure } from '@/components/ui/disclosure';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import type { ApiClient } from '@/lib/api/client';
import { InvitationsPanel } from '../components/invitations/invitations-panel';
import { InvitePeopleSheet } from '../components/invitations/invite-people-sheet';
import { MembersPanel } from '../components/members/members-panel';
import { RolesMatrix } from '../components/members/roles-matrix';
import type { TeamSearch } from '../model/team-search';
import {
  assignableRoles,
  roleLimitSentence,
  type WorkspaceRole,
} from '../model/workspace-roles';
import { useInvitationCommand } from '../data/mutations/use-invitation-command';
import {
  workspaceInvitationsInfiniteQueryOptions,
  workspaceMembersInfiniteQueryOptions,
} from '../data/workspaces.queries';
import { pluralWord } from '@/lib/format/count';
import { lossOf, type AccessLoss } from '../model/member-access';

/** Why the page can't show the team, if it can't. */
function blockedCopy({
  role,
  canRead,
  losses,
}: Readonly<{
  role: WorkspaceRole;
  canRead: boolean;
  losses: readonly (AccessLoss | undefined)[];
}>): Readonly<{ title: string; description: string }> | undefined {
  if (!canRead)
    return {
      title: 'Workspace members are unavailable',
      description: roleLimitSentence(
        role,
        'member:read',
        'see who’s in this workspace',
      ),
    };
  if (losses.includes('permission'))
    return {
      title: 'Member access was removed',
      description: 'Your role no longer lets you see this workspace’s members.',
    };
  return undefined;
}

function describeInvitationAvailability({
  available,
  failed,
}: Readonly<{ available: boolean | undefined; failed: boolean }>) {
  if (available) return { message: undefined, tone: 'warning' as const };
  if (available === false)
    return {
      message:
        'Invitations are unavailable on this server. Ask the operator to configure invitations.',
      tone: 'warning' as const,
    };
  if (failed)
    return {
      message:
        'Invitation availability couldn’t be checked. Retry on the Invitations tab.',
      tone: 'warning' as const,
    };
  return {
    message: 'Checking invitation availability…',
    tone: 'info' as const,
  };
}

/** The title, who the team is for, and Invite. */
function TeamHeader({
  workspaceName,
  memberCount,
  canManage,
  invitationAvailability,
  onInvite,
}: Readonly<{
  workspaceName: string;
  /** "12" or "50+" once the members have loaded. */
  memberCount: string;
  canManage: boolean;
  invitationAvailability: ReturnType<typeof describeInvitationAvailability>;
  onInvite: () => void;
}>) {
  return (
    <>
      <PageHeader>
        <div className="flex flex-col gap-3">
          <PageHeaderTitle>Team</PageHeaderTitle>
          <p className="text-meta text-subtle-foreground">
            Who can do what in {workspaceName}. {memberCount}{' '}
            {pluralWord(Number.parseInt(memberCount, 10), 'member')}.
          </p>
        </div>
        {canManage ? (
          <PageHeaderActions>
            <Button
              type="button"
              variant="primary"
              disabled={invitationAvailability.message !== undefined}
              aria-describedby={
                invitationAvailability.message === undefined
                  ? undefined
                  : 'invitation-availability'
              }
              onClick={onInvite}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Invite people
            </Button>
          </PageHeaderActions>
        ) : null}
      </PageHeader>
      {canManage && invitationAvailability.message !== undefined ? (
        <Notice id="invitation-availability" tone={invitationAvailability.tone}>
          {invitationAvailability.message}
        </Notice>
      ) : null}
    </>
  );
}

/**
 * Who has access and what they can do: members with inline roles, the
 * invitations people are still to accept, and the roles matrix beside them.
 */
export function WorkspaceMembersPage({
  apiClient,
  user,
  workspace,
  search,
  onSearchChange,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  search: TeamSearch;
  onSearchChange: (next: TeamSearch) => void;
}>) {
  const canRead = workspace.capabilities.includes('member:read');
  const canManage = workspace.capabilities.includes('member:manage');
  const [commandLoss, setCommandLoss] = useState<AccessLoss>();
  const [memberSearch, setMemberSearch] = useState('');
  const members = useInfiniteQuery({
    ...workspaceMembersInfiniteQueryOptions(apiClient, user.id, workspace.id),
    enabled: canRead,
  });
  const invitations = useInfiniteQuery({
    ...workspaceInvitationsInfiniteQueryOptions(
      apiClient,
      user.id,
      workspace.id,
    ),
    enabled: canRead && canManage,
  });
  const command = useInvitationCommand({
    apiClient,
    userId: user.id,
    workspaceId: workspace.id,
    onPermissionLost: () => {
      setCommandLoss('permission');
    },
  });
  const memberItems = members.data?.pages.flatMap((page) => page.items) ?? [];
  const invitationItems =
    invitations.data?.pages.flatMap((page) => page.items) ?? [];
  const issuanceAvailable = invitations.data?.pages[0]?.issuanceAvailable;
  const invitationAvailability = describeInvitationAvailability({
    available: issuanceAvailable,
    failed: invitations.isError,
  });
  const pendingInvitations = invitationItems.filter(
    (item) => item.status === 'pending',
  ).length;
  const losses = [
    commandLoss,
    lossOf({ query: members, notFoundIsLoss: false }),
    lossOf({ query: invitations, notFoundIsLoss: true }),
  ];

  const blocked = blockedCopy({ role: workspace.role, canRead, losses });
  if (blocked !== undefined)
    return <UnavailablePage heading="Team" {...blocked} />;

  const openInvite = () => {
    onSearchChange({ ...search, invite: true });
  };
  const memberCount = `${String(memberItems.length)}${members.hasNextPage ? '+' : ''}`;

  return (
    <div className="flex max-w-260 flex-col gap-8">
      <TeamHeader
        workspaceName={workspace.name}
        memberCount={memberCount}
        canManage={canManage}
        invitationAvailability={invitationAvailability}
        onInvite={openInvite}
      />
      {canManage && pendingInvitations > 0 ? (
        <p className="-mt-4 flex items-center gap-2 text-meta">
          <StatusMark tone="queued">
            {pendingInvitations} {pluralWord(pendingInvitations, 'invitation')}{' '}
            pending
          </StatusMark>
          <span aria-hidden="true" className="text-subtle-foreground">
            ·
          </span>
          <a
            href="#invitations"
            className="text-muted-foreground hover:text-foreground focus-ring"
          >
            Review
          </a>
        </p>
      ) : null}
      <SearchInput
        className="w-full sm:w-85"
        placeholder="Find a member by name or email"
        aria-label="Find a member by name or email"
        value={memberSearch}
        onChange={(event) => {
          setMemberSearch(event.target.value);
        }}
      />
      <MembersPanel
        apiClient={apiClient}
        user={user}
        workspace={workspace}
        query={members}
        members={memberItems}
        search={memberSearch}
      />
      {canManage ? (
        <section
          id="invitations"
          aria-labelledby="invitations-heading"
          className="flex flex-col gap-2"
        >
          <RuleHeading id="invitations-heading" count={pendingInvitations}>
            Invitations
          </RuleHeading>
          <InvitationsPanel
            query={invitations}
            invitations={invitationItems}
            command={command}
          />
        </section>
      ) : null}
      <Disclosure summary="Compare roles">
        <RolesMatrix yourRole={workspace.role} />
      </Disclosure>

      {canManage && (issuanceAvailable ?? false) ? (
        <InvitePeopleSheet
          open={
            (search.invite ?? false) || command.activeAttempt?.kind === 'create'
          }
          roles={assignableRoles(workspace.role)}
          command={command}
          onClose={() => {
            onSearchChange(search.tab === undefined ? {} : { tab: search.tab });
          }}
        />
      ) : null}
    </div>
  );
}
