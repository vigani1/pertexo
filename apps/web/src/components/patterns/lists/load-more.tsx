import { ReadRecovery } from '../states/read-recovery';
import { describeReadError } from '@/lib/api/error-copy';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';

/**
 * The next page of a list: one button that loads it (and retries it after a
 * failure) and one line when it failed, giving the cause and confirming that
 * what is already shown never changes.
 */
export function LoadMore({
  subject,
  hasNextPage,
  loading,
  failed,
  error,
  disabled = false,
  onLoadMore,
  label = 'Load more',
}: Readonly<{
  /** What the list holds, in the plural: "runs", "members". */
  subject: string;
  hasNextPage: boolean;
  loading: boolean;
  failed: boolean;
  error?: unknown;
  disabled?: boolean;
  onLoadMore: () => void;
  /** Tells two lists on one page apart, e.g. "Load more invitations". */
  label?: string;
}>) {
  if (!hasNextPage && !failed) return null;
  return (
    <div className="flex flex-col items-center gap-2 pt-2">
      {failed ? (
        <Notice tone="destructive">
          <ReadRecovery
            message={`${
              error === undefined
                ? `More ${subject} couldn’t be loaded.`
                : describeReadError(error, `More ${subject}`)
            } The ones above are unchanged.`}
            error={error}
            resource={`More ${subject}`}
            retrying={loading}
            disabled={disabled}
            retry={onLoadMore}
            label="Retry next page"
          />
        </Notice>
      ) : (
        <ProgressButton
          type="button"
          variant="outline"
          className="min-w-32"
          pending={loading}
          disabled={disabled}
          pendingLabel="Loading…"
          onClick={onLoadMore}
        >
          {label}
        </ProgressButton>
      )}
    </div>
  );
}
