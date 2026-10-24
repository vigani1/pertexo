import type {
  ConnectionResponse,
  FailureNotificationDestinationResponse,
} from '@pertexo/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  FailedReadState,
  QueryView,
} from '@/components/patterns/states/query-view';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/ui/empty';
import { SkeletonRows } from '@/components/ui/skeleton';
import type { FailureNotificationDestinationList } from '../data/failure-notifications.api';
import type { ChannelNames } from '../model/channel-names';
import type { DestinationMutationScope } from '../data/failure-notifications.mutations';
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
  return (
    <QueryView
      query={query}
      resource="Alert destinations"
      loading={<SkeletonRows label="Loading alert destinations" rows={2} />}
      error={(failed) => (
        <FailedReadState
          title="Alert destinations couldn’t be loaded"
          {...failed}
        />
      )}
      isEmpty={() => items.length === 0}
      empty={
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
      }
    >
      {() => (
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
      )}
    </QueryView>
  );
}
