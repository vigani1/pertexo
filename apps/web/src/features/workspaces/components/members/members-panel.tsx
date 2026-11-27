import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkspaceMember,
  WorkspaceMembersResponse,
} from '@pertexo/contracts';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { LoadMore } from '@/components/patterns/lists/load-more';
import {
  FailedReadState,
  QueryView,
} from '@/components/patterns/states/query-view';
import {
  Empty,
  EmptyDescription,
  EmptyTitle,
} from '@/components/patterns/states/empty';
import { SkeletonRows } from '@/components/patterns/states/loading';
import type { ApiClient } from '@/lib/api/client';
import { MemberManagement } from './management';
import { whoCan } from '../../model/workspace-roles';
import { sentenceStart } from '@/lib/format/sentence';

type MembersQuery = UseInfiniteQueryResult<
  InfiniteData<WorkspaceMembersResponse>
>;

/** Everyone with access, grouped by role and loaded page by page. */
export function MembersPanel({
  apiClient,
  user,
  workspace,
  query,
  members,
  search,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  query: MembersQuery;
  members: readonly WorkspaceMember[];
  search: string;
}>) {
  return (
    <div className="flex flex-col gap-3">
      <QueryView
        query={query}
        resource="Members"
        loading={<SkeletonRows label="Loading members" mark="avatar" />}
        error={(failed) => (
          <FailedReadState title="Members couldn’t be loaded" {...failed} />
        )}
        isEmpty={() => members.length === 0}
        empty={
          search !== '' ? (
            <p className="py-6 text-sm text-muted-foreground">
              No member matches “{search}”.
            </p>
          ) : (
            <Empty>
              <EmptyTitle>No members to show</EmptyTitle>
              <EmptyDescription>
                Nobody else can see this workspace yet.{' '}
                {sentenceStart(whoCan('member:manage'))} can invite people from
                here.
              </EmptyDescription>
            </Empty>
          )
        }
      >
        {() => (
          <MemberManagement
            apiClient={apiClient}
            user={user}
            workspace={workspace}
            members={members}
          />
        )}
      </QueryView>
      <LoadMore
        subject="members"
        hasNextPage={query.hasNextPage}
        loading={query.isFetchingNextPage}
        failed={query.isFetchNextPageError}
        error={query.error}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </div>
  );
}
