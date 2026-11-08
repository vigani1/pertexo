import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  RecentLog,
  RecentLogEntry,
} from '@/components/patterns/lists/recent-log';
import { describeCoordinatedEvent } from '@/features/trigger-events/presentation.public';
import { formatDateTime } from '@/lib/format/time';
import { Button } from '@/components/ui/button';
import type { MemberFormScope } from '../data/forms.api';
import { formEventsQueryOptions } from '../data/forms.queries';
export function FormEventHistory({
  scope,
}: Readonly<{ scope: MemberFormScope }>) {
  const query = useInfiniteQuery(formEventsQueryOptions(scope));
  return (
    <div className="flex flex-col gap-2">
      <RecentLog
        query={query}
        items={query.data?.pages.flatMap((page) => page.items)}
        itemKey={(event) => event.id}
        renderItem={(event) => {
          const look = describeCoordinatedEvent(event);
          return (
            <RecentLogEntry
              {...look}
              at={event.receivedAt}
              meta={`v${String(event.versionNumber)}`}
              detail={`${look.detail}${event.dueAt === null ? '' : ` Next check ${formatDateTime(event.dueAt)}.`}`}
              action={
                event.runId === null ? undefined : (
                  <Link
                    to="/w/$workspaceId/runs/$runId"
                    params={{
                      workspaceId: scope.workspaceId,
                      runId: event.runId,
                    }}
                    className="text-xs underline"
                  >
                    Open run
                  </Link>
                )
              }
            />
          );
        }}
        copy={{
          title: 'Coordinated form events',
          note: 'Kept for 90 days',
          subject: 'events',
          loadMoreLabel: 'Load older events',
          empty:
            'Coordinated submissions will appear here. Inputs and keys are never shown.',
        }}
      />
      <Button
        variant="ghost"
        size="sm"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh events
      </Button>
    </div>
  );
}
