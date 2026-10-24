import { RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { SettingsSection } from '@/components/patterns/settings/section';
import {
  QueryView,
  type ReadQuery,
} from '@/components/patterns/states/query-view';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { SkeletonThread } from '@/components/ui/skeleton';
import { describeReadError } from '@/lib/api/error-copy';
import { accessLost } from '../model/usage-access';

/**
 * One section of the Usage page, laid out like every settings section, with
 * its own refresh so a failed capacity read never hides run counts. The page
 * header says how fresh they are. Losing access hides figures read earlier.
 */
export function UsageSnapshot<Data>({
  title,
  description,
  controls,
  query,
  children,
}: Readonly<{
  title: string;
  description: string;
  /** Controls that stay usable even when the read fails, such as a window. */
  controls?: ReactNode;
  query: ReadQuery<Data>;
  children: (data: Data) => ReactNode;
}>) {
  return (
    <SettingsSection
      title={title}
      description={description}
      action={
        <ProgressButton
          variant="ghost"
          size="sm"
          aria-label={`Refresh ${title.toLowerCase()}`}
          className="-ml-2.5"
          pending={query.isFetching}
          pendingLabel="Refreshing…"
          icon={<RefreshCwIcon data-icon="inline-start" aria-hidden="true" />}
          onClick={() => void query.refetch()}
        >
          Refresh
        </ProgressButton>
      }
    >
      {controls}
      <QueryView
        query={query}
        resource={title}
        loading={
          <div role="status" aria-label={`Loading ${title.toLowerCase()}`}>
            <SkeletonThread order={0} />
          </div>
        }
        failure={(error) =>
          accessLost(error) ? (
            <Notice tone="destructive">
              {describeReadError(error, title)}
            </Notice>
          ) : undefined
        }
      >
        {children}
      </QueryView>
    </SettingsSection>
  );
}
