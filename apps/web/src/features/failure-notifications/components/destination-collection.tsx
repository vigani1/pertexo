import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import type { UseQueryResult } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/ui/empty';
import { SkeletonRows } from '@/components/ui/skeleton';
import { describeReadError } from '@/lib/api/api-error-copy';
import type { FailureNotificationDestinationList } from '../failure-notifications.api';
import type { ChannelNames } from '../model/channel-names';
import type { DestinationMutationScope } from '../failure-notifications.mutations';
import { DestinationRow } from './destination-row';

/** The destinations list with its loading, failed, stale and empty states. */
export function DestinationCollection({
  query,
  items,
  connections,
  channelNames,
  scope,
  canManage,
  onAdd,
  onEdit,
}: Readonly<{
  query: UseQueryResult<FailureNotificationDestinationList>;
  items: readonly FailureNotificationDestinationResponse[];
  connections: readonly ConnectionResponse[];
  channelNames: ChannelNames;
  scope: DestinationMutationScope;
  canManage: boolean;
  onAdd: () => void;
  onEdit: (destinationId: string) => void;
}>) {
  if (query.isPending)
    return <SkeletonRows label="Loading alert destinations" rows={2} />;
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
        <StaleLine
          updatedAt={query.dataUpdatedAt}
          retrying={query.isRefetching}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      <ul aria-label="Alert destinations" className="flex flex-col">
        {items.map((destination) => (
          <DestinationRow
            key={destination.id}
            scope={scope}
            destination={destination}
            connections={connections}
            channelNames={channelNames}
            canManage={canManage}
            onEdit={onEdit}
          />
        ))}
      </ul>
    </div>
  );
}
