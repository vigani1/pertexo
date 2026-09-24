import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { Status } from '@/components/ui/status';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isUnauthenticated } from '@/features/auth/session-identity.public';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import { InvitationsPanel } from './components/invitations/invitations-panel';
import { InviteLens } from './components/invitations/invite-lens';
import { MembersPanel } from './components/members/members-panel';
import { RolesMatrix } from './components/members/roles-matrix';
import type { TeamSearch } from './model/team-search';
import { assignableRoles } from './model/workspace-roles';
import { useInvitationCommand } from './mutations/use-invitation-command';
import {
  workspaceInvitationsInfiniteQueryOptions,
  workspaceMembersInfiniteQueryOptions,
} from './workspaces.queries';

type AccessLoss = 'authentication' | 'permission';

function Blocked({
  title,
  description,
}: Readonly<{ title: string; description: string }>) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader>
        <PageHeaderTitle>Team</PageHeaderTitle>
      </PageHeader>
      <Empty>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </Empty>
    </div>
  );
}

function lossOf(
  error: unknown,
  notFoundIsLoss: boolean,
): AccessLoss | undefined {
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
  const pendingInvitations = invitationItems.filter(
    (item) => item.status === 'pending',
  ).length;
  const losses = [
    commandLoss,
    members.isError ? lossOf(members.error, false) : undefined,
    invitations.isError ? lossOf(invitations.error, true) : undefined,
  ];

  if (!canRead)
    return (
      <Blocked
        title="Workspace members are unavailable"
        description="Your role can’t see who’s in this workspace."
      />
    );
  if (losses.includes('authentication'))
    return (
      <Blocked
        title="Your session is no longer available"
        description="Sign in again to see or manage this workspace’s members."
      />
    );
  if (losses.includes('permission'))
    return (
      <Blocked
        title="Member access was removed"
        description="Your role no longer lets you see this workspace’s members."
      />
    );

  const tab =
    canManage && search.tab === 'invitations' ? 'invitations' : 'members';
  const openInvite = () => {
    onSearchChange({ ...search, invite: true });
  };
  const memberCount = `${String(memberItems.length)}${members.hasNextPage ? '+' : ''}`;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader>
        <div>
          <PageHeaderTitle>Team</PageHeaderTitle>
          {members.isSuccess ? (
            <PageHeaderMeta>
              <span>
                <b className="text-foreground">{memberCount}</b>{' '}
                {memberItems.length === 1 ? 'member' : 'members'}
              </span>
              {pendingInvitations > 0 ? (
                <Status tone="queued">
                  {pendingInvitations}{' '}
                  {pendingInvitations === 1 ? 'invitation' : 'invitations'}{' '}
                  pending
                </Status>
              ) : null}
            </PageHeaderMeta>
          ) : null}
        </div>
        {canManage ? (
          <PageHeaderActions>
            <Button type="button" variant="primary" onClick={openInvite}>
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Invite people
            </Button>
          </PageHeaderActions>
        ) : null}
      </PageHeader>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Tabs
          value={tab}
          onValueChange={(next) => {
            onSearchChange({
              ...(search.invite === true ? { invite: true } : {}),
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
                onInvite={openInvite}
              />
            </TabsContent>
          ) : null}
        </Tabs>
        <RolesMatrix yourRole={workspace.role} />
      </div>

      {canManage ? (
        <InviteLens
          open={
            search.invite === true || command.activeAttempt?.kind === 'create'
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
