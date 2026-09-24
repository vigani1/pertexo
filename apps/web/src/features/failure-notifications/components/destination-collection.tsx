import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import type { UseQueryResult } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/ui/empty';
import { Notice } from '@/components/ui/notice';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import { describeReadError } from '@/lib/api/api-error-copy';
import { formatClock } from '@/lib/format-time';
import type { FailureNotificationDestinationList } from '../failure-notifications.api';
import type { DestinationMutationScope } from '../failure-notifications.mutations';
import { DestinationRow } from './destination-row';

function ListSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading alert destinations"
      className="flex flex-col gap-5"
    >
      {[58, 34].map((width, order) => (
        <div
          key={width}
          className="grid grid-cols-[2rem_minmax(0,14rem)_minmax(0,1fr)] items-center gap-4"
        >
          <Skeleton className="size-8 rounded-md" />
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

/** The destinations list with its loading, failed, stale and empty states. */
export function DestinationCollection({
  query,
  items,
  connections,
  scope,
  canManage,
  onAdd,
  onEdit,
}: Readonly<{
  query: UseQueryResult<FailureNotificationDestinationList>;
  items: readonly FailureNotificationDestinationResponse[];
  connections: readonly ConnectionResponse[];
  scope: DestinationMutationScope;
  canManage: boolean;
  onAdd: () => void;
  onEdit: (destinationId: string) => void;
}>) {
  if (query.isPending) return <ListSkeleton />;
  if (query.isError && items.length === 0)
    return (
      <Empty>
        <EmptyTitle>Alert destinations couldn’t be loaded</EmptyTitle>
        <EmptyDescription>
          {describeReadError(query.error, 'Alert destinations')}
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
  if (items.length === 0)
    return (
      <Empty>
        <EmptyTitle>No alert destinations yet</EmptyTitle>
        <EmptyDescription>
          Add a Slack channel or an email address, and failed runs will reach
          the people who can fix them.
        </EmptyDescription>
        {canManage ? (
          <EmptyActions>
            <Button type="button" variant="primary" onClick={onAdd}>
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add destination
            </Button>
          </EmptyActions>
        ) : null}
      </Empty>
    );
  return (
    <div className="flex flex-col gap-3">
      {query.isError ? (
        <Notice role="alert" tone="attention">
          Showing destinations from{' '}
          {formatClock(new Date(query.dataUpdatedAt).toISOString())}. The latest
          refresh didn’t go through.{' '}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={query.isRefetching}
            onClick={() => void query.refetch()}
          >
            {query.isRefetching ? 'Retrying…' : 'Retry'}
          </Button>
        </Notice>
      ) : null}
      <ul aria-label="Alert destinations" className="flex flex-col">
        {items.map((destination) => (
          <DestinationRow
            key={destination.id}
            scope={scope}
            destination={destination}
            connections={connections}
            canManage={canManage}
            onEdit={onEdit}
          />
        ))}
      </ul>
    </div>
  );
}
