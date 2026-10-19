import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';

/**
 * The next page of a list: one button that loads it (and retries it after a
 * failure) and one line when it failed. What is already shown never changes.
 */
export function LoadMore({
  subject,
  hasNextPage,
  loading,
  failed,
  onLoadMore,
  label = 'Load more',
}: Readonly<{
  /** What the list holds, in the plural: "runs", "members". */
  subject: string;
  hasNextPage: boolean;
  loading: boolean;
  failed: boolean;
  onLoadMore: () => void;
  /** Tells two lists on one page apart, e.g. "Load more invitations". */
  label?: string;
}>) {
  if (!hasNextPage && !failed) return null;
  return (
    <div className="flex flex-col items-center gap-2 pt-2">
      <ProgressButton
        type="button"
        variant="outline"
        className="min-w-32"
        pending={loading}
        pendingLabel="Loading…"
        onClick={onLoadMore}
      >
        {failed ? 'Retry next page' : label}
      </ProgressButton>
      {failed ? (
        <Notice tone="destructive">
          More {subject} couldn’t be loaded. The ones above are unchanged.
        </Notice>
      ) : null}
    </div>
  );
}
