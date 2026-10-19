import { RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { SettingsSection } from '@/components/patterns/settings/section';
import { StaleLine } from '@/components/patterns/states/stale-line';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { SkeletonThread } from '@/components/ui/skeleton';
import { describeReadError } from '@/lib/api/error-copy';
import { cn } from '@/lib/utils';

/**
 * One section of the Usage page, laid out like every settings section, with
 * its own refresh so a failed capacity read never hides run counts. The page
 * header says how fresh they are.
 */
export function UsageSnapshot({
  title,
  description,
  controls,
  snapshotAt,
  error,
  pending,
  retrying,
  onRetry,
  children,
}: Readonly<{
  title: string;
  description: string;
  /** Controls that stay usable even when the read fails, such as a window. */
  controls?: ReactNode;
  snapshotAt: string | undefined;
  error: unknown;
  pending: boolean;
  retrying: boolean;
  onRetry: () => void;
  children: ReactNode;
}>) {
  return (
    <SettingsSection
      title={title}
      description={description}
      action={
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Refresh ${title.toLowerCase()}`}
          disabled={retrying}
          className="-ml-2.5"
          onClick={onRetry}
        >
          <RefreshCwIcon
            data-icon="inline-start"
            aria-hidden="true"
            className={cn(retrying && 'motion-safe:animate-spin')}
          />
          {retrying ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
    >
      {controls}
      {snapshotAt === undefined ? (
        pending ? (
          <div role="status" aria-label={`Loading ${title.toLowerCase()}`}>
            <SkeletonThread order={0} />
          </div>
        ) : (
          <Notice tone="destructive">{describeReadError(error, title)}</Notice>
        )
      ) : (
        <>
          {error === null || error === undefined ? null : (
            <StaleLine
              updatedAt={Date.parse(snapshotAt)}
              retrying={retrying}
              onRetry={onRetry}
            />
          )}
          {children}
        </>
      )}
    </SettingsSection>
  );
}
