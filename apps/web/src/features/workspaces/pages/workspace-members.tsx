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
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { UnavailablePage } from '@/components/patterns/states/unavailable-page';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isUnauthenticated } from '@/features/auth/session/identity.public';
import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { InvitationsPanel } from '../components/invitations/panel';
import { InvitePeopleSheet } from '../components/invitations/invite-people-sheet';
import { MembersPanel } from '../components/members/panel';
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

type AccessLoss = 'authentication' | 'permission';

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
  if (losses.includes('authentication'))
    return {
      title: 'Your session is no longer available',
      description: 'Sign in again to see or manage this workspace’s members.',
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

/** The title, how many people and pending invitations, and Invite. */
function TeamHeader({
  pendingInvitations,
  canManage,
  invitationAvailability,
  onInvite,
}: Readonly<{
  /** "12" or "50+" once the members have loaded. */
  pendingInvitations: number;
  canManage: boolean;
  invitationAvailability: ReturnType<typeof describeInvitationAvailability>;
  onInvite: () => void;
}>) {
  return (
    <>
      <PageHeader>
        <div>
          <PageHeaderTitle>Team</PageHeaderTitle>
          {/* The Members tab counts people; the header only flags what's
            waiting on someone. */}
          {pendingInvitations > 0 ? (
            <PageHeaderMeta>
              <Status tone="queued">
                {pendingInvitations}{' '}
                {pendingInvitations === 1 ? 'invitation' : 'invitations'}{' '}
                pending
              </Status>
            </PageHeaderMeta>
          ) : null}
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

function lossOf({
  query,
  notFoundIsLoss,
}: Readonly<{
  query: Readonly<{ isError: boolean; error: unknown }>;
  notFoundIsLoss: boolean;
}>): AccessLoss | undefined {
  if (!query.isError) return undefined;
  const error = query.error;
  if (isUnauthenticated(error)) return 'authentication';
  if (!isApiError(error)) return undefined;
  if (error.status === 403 || (notFoundIsLoss && error.status === 404))
    return 'permission';
  return undefined;
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
    onAuthenticationLost: () => {
      setCommandLoss('authentication');
    },
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

  const tab =
    canManage && search.tab === 'invitations' ? 'invitations' : 'members';
  const openInvite = () => {
    onSearchChange({ ...search, invite: true });
  };
  const memberCount = `${String(memberItems.length)}${members.hasNextPage ? '+' : ''}`;

  return (
    <div className="flex flex-col gap-8">
      <TeamHeader
        pendingInvitations={pendingInvitations}
        canManage={canManage}
        invitationAvailability={invitationAvailability}
        onInvite={openInvite}
      />

      {/* The roles matrix reads below the list as a settings band, so its
          abilities have the width they need instead of wrapping. */}
      <div className="flex flex-col gap-8">
        <Tabs
          value={tab}
          onValueChange={(next) => {
            onSearchChange({
              ...((search.invite ?? false) ? { invite: true } : {}),
              ...(next === 'invitations' ? { tab: 'invitations' } : {}),
            });
          }}
        >
          <TabsList>
            <TabsTrigger value="members">
              Members
              <span className="font-mono text-xs text-subtle-foreground">
                {memberCount}
              </span>
            </TabsTrigger>
            {canManage ? (
              <TabsTrigger value="invitations">
                Invitations
                <span className="font-mono text-xs text-subtle-foreground">
                  {pendingInvitations}
                </span>
              </TabsTrigger>
            ) : null}
          </TabsList>
          <TabsContent value="members" className="pt-3">
            <MembersPanel
              apiClient={apiClient}
              user={user}
              workspace={workspace}
              query={members}
              members={memberItems}
              onAccessLost={setCommandLoss}
            />
          </TabsContent>
          {canManage ? (
            <TabsContent value="invitations" className="pt-3">
              <InvitationsPanel
                query={invitations}
                invitations={invitationItems}
                command={command}
              />
            </TabsContent>
          ) : null}
        </Tabs>
        <RolesMatrix yourRole={workspace.role} />
      </div>

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
