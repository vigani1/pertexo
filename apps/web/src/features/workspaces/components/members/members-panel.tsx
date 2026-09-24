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
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/ui/empty';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import type { ApiClient } from '@/lib/api/client';
import { describeReadError } from '@/lib/api/api-error-copy';
import { MemberRoleManagement } from './member-role-management';

type MembersQuery = UseInfiniteQueryResult<
  InfiniteData<WorkspaceMembersResponse>
>;

function MembersSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading members"
      className="flex flex-col gap-5 py-2"
    >
      {[62, 44, 70].map((width, order) => (
        <div
          key={width}
          className="grid grid-cols-[2rem_minmax(0,12rem)_minmax(0,1fr)] items-center gap-4"
        >
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-2.5" />
          <SkeletonThread
            order={order}
            style={{ width: `${String(width)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

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
  if (query.isPending) return <MembersSkeleton />;
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
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
      {query.isFetchNextPageError ? (
        <p role="alert" className="text-center text-sm text-destructive">
          More members couldn’t be loaded. Try again.
        </p>
      ) : null}
    </div>
  );
}
