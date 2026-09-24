import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkspaceMember,
  WorkspaceMembersResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { LoadMore } from '@/components/patterns/load-more';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/ui/empty';
import { SkeletonRows } from '@/components/ui/skeleton';
import type { ApiClient } from '@/lib/api/client';
import { describeReadError } from '@/lib/api/api-error-copy';
import { MemberRoleManagement } from './member-role-management';

type MembersQuery = UseInfiniteQueryResult<
  InfiniteData<WorkspaceMembersResponse>
>;

/** The Members tab: everyone with access, loaded page by page. */
export function MembersPanel({
  apiClient,
  user,
  workspace,
  query,
  members,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  query: MembersQuery;
  members: readonly WorkspaceMember[];
  onAccessLost: (loss: 'authentication' | 'permission') => void;
}>) {
  if (query.isPending)
    return <SkeletonRows label="Loading members" mark="avatar" />;
  if (query.isError && members.length === 0)
    return (
      <Empty>
        <EmptyTitle>Members couldn’t be loaded</EmptyTitle>
        <EmptyDescription>
          {describeReadError(query.error, 'Members')}
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
  if (members.length === 0)
    return (
      <Empty>
        <EmptyTitle>No members to show</EmptyTitle>
        <EmptyDescription>
          Nobody else can see this workspace yet. Owners and admins can invite
          people from here.
        </EmptyDescription>
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
      <MemberRoleManagement
        apiClient={apiClient}
        user={user}
        workspace={workspace}
        members={members}
        onAccessLost={onAccessLost}
      />
      <LoadMore
        subject="members"
        hasNextPage={query.hasNextPage}
        loading={query.isFetchingNextPage}
        failed={query.isFetchNextPageError}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </div>
  );
}
