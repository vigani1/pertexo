import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { isUnauthenticated } from '@/features/auth/public';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { WorkspaceMembersTable } from './components/members/workspace-members-table';
import { MemberRoleDialog } from './components/members/member-role-dialog';
import { useMemberRoleCommand } from './mutations/use-member-role-command';
import { WorkspaceSettingsNavigation } from './components/settings/workspace-settings-navigation';
import { workspaceMembersInfiniteQueryOptions } from './workspaces.queries';

export function WorkspaceMembersPage({
  apiClient,
  user,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
}>) {
  const canRead = workspace.capabilities.includes('member:read');
  const [commandAccessLoss, setCommandAccessLoss] = useState<
    'authentication' | 'permission'
  >();
  const query = useInfiniteQuery({
    ...workspaceMembersInfiniteQueryOptions(apiClient, user.id, workspace.id),
    enabled: canRead,
  });
  const members = query.data?.pages.flatMap((page) => page.items) ?? [];
  const queryAuthenticationLost =
    query.isError && isUnauthenticated(query.error);
  const authenticationLost =
    commandAccessLoss === 'authentication' || queryAuthenticationLost;
  const permissionLost =
    commandAccessLoss === 'permission' ||
    (query.isError && isApiError(query.error) && query.error.status === 403);
  const accessLost = authenticationLost || permissionLost;

  if (!canRead)
    return (
      <Empty>
        <EmptyTitle>Workspace members are unavailable</EmptyTitle>
        <EmptyDescription>
          Your workspace role does not allow you to view members.
        </EmptyDescription>
      </Empty>
    );

  if (accessLost)
    return (
      <Empty>
        <EmptyTitle>
          {authenticationLost
            ? 'Your session is no longer available'
            : 'Member access was removed'}
        </EmptyTitle>
        <EmptyDescription>
          {authenticationLost
            ? 'Sign in again before viewing or managing workspace members.'
            : 'Your current session no longer has permission to view workspace members.'}
        </EmptyDescription>
      </Empty>
    );

  return (
    <div>
      <WorkspaceSettingsNavigation workspace={workspace} />
      <header>
        <p className="font-mono text-xs tracking-[0.2em] text-secondary">
          WORKSPACE ACCESS
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          Members
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          See who can access {workspace.name} and the role assigned to each
          member.
        </p>
      </header>

      {query.isError && members.length > 0 && !query.isFetchNextPageError ? (
        <div
          role="alert"
          className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <p className="text-sm text-destructive">
            These members may be stale because the latest refresh failed.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={query.isRefetching}
            onClick={() => void query.refetch()}
          >
            {query.isRefetching ? 'Retrying…' : 'Retry refresh'}
          </Button>
        </div>
      ) : null}

      <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 border-y border-border py-3 font-mono text-[0.68rem] tracking-[0.1em] text-muted-foreground uppercase">
        <span>{members.length} loaded</span>
        <span>Workspace roles</span>
      </div>

      {query.isPending ? (
        <p role="status" className="py-16 text-sm text-muted-foreground">
          Loading workspace members…
        </p>
      ) : query.isError && members.length === 0 ? (
        <Empty>
          <EmptyTitle>Workspace members could not be loaded</EmptyTitle>
          <EmptyDescription>{membersError(query.error)}</EmptyDescription>
          <Button
            className="mt-6"
            type="button"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </Empty>
      ) : members.length === 0 ? (
        <Empty>
          <EmptyTitle>No workspace members</EmptyTitle>
          <EmptyDescription>
            This workspace does not currently have any visible members.
          </EmptyDescription>
        </Empty>
      ) : (
        <>
          <MemberRoleManagement
            apiClient={apiClient}
            user={user}
            workspace={workspace}
            members={members}
            onAccessLost={setCommandAccessLoss}
          />
          {query.hasNextPage ? (
            <div className="mt-6 flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
          {query.isFetchNextPageError ? (
            <p
              role="alert"
              className="mt-4 text-center text-sm text-destructive"
            >
              The next member page could not be loaded. Try again.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function MemberRoleManagement({
  apiClient,
  user,
  workspace,
  members,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  members: readonly WorkspaceMember[];
  onAccessLost: (loss: 'authentication' | 'permission') => void;
}>) {
  const [selectedMember, setSelectedMember] = useState<WorkspaceMember>();
  const roleCommand = useMemberRoleCommand({
    apiClient,
    actorUserId: user.id,
    workspaceId: workspace.id,
    onConflict: () => {
      setSelectedMember(undefined);
    },
    onAuthenticationLost: () => {
      onAccessLost('authentication');
    },
    onPermissionLost: () => {
      onAccessLost('permission');
    },
    onTargetUnavailable: () => {
      setSelectedMember(undefined);
    },
  });
  const dialogMember = roleCommand.activeMember ?? selectedMember;

  return (
    <>
      <WorkspaceMembersTable
        members={members}
        actionsDisabled={roleCommand.locked}
        canManage={(member) =>
          workspace.capabilities.includes('member:manage') &&
          canManageMember(workspace.role, user.id, member)
        }
        onChangeRole={(member) => {
          if (!roleCommand.locked) setSelectedMember(member);
        }}
      />
      <MemberRoleDialog
        key={`${dialogMember?.userId ?? 'closed'}:${String(dialogMember?.roleRevision ?? 0)}`}
        {...(dialogMember === undefined ? {} : { member: dialogMember })}
        allowedRoles={allowedRoles(workspace.role)}
        pending={roleCommand.pending}
        locked={roleCommand.locked}
        retryAvailable={roleCommand.retryAvailable}
        {...(roleCommand.error === undefined ||
        roleCommand.errorTargetUserId !== dialogMember?.userId
          ? {}
          : { error: roleCommand.error })}
        onClose={() => {
          setSelectedMember(undefined);
        }}
        onChange={(role) =>
          selectedMember === undefined
            ? Promise.resolve(false)
            : roleCommand.start(selectedMember, role)
        }
        onRetry={roleCommand.retry}
        onDismissUncertain={roleCommand.dismiss}
      />
    </>
  );
}

const delegatedRoles = ['builder', 'operator', 'viewer'] as const;

function allowedRoles(actorRole: AccessibleWorkspace['role']) {
  return actorRole === 'owner'
    ? (['admin', ...delegatedRoles] as const)
    : delegatedRoles;
}

function canManageMember(
  actorRole: AccessibleWorkspace['role'],
  actorUserId: string,
  member: WorkspaceMember,
): boolean {
  if (
    member.userId === actorUserId ||
    member.membershipStatus !== 'active' ||
    member.role === 'owner'
  )
    return false;
  if (actorRole === 'owner') return true;
  return (
    actorRole === 'admin' && delegatedRoles.some((role) => role === member.role)
  );
}

function membersError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 403)
      return 'You no longer have access to members in this workspace.';
    if (error.kind === 'network')
      return 'Workspace members could not be reached. Check your network and try again.';
    if (error.kind === 'timeout')
      return 'Workspace members took too long to load. Try again.';
  }
  return 'Workspace members could not be loaded. Try again.';
}
