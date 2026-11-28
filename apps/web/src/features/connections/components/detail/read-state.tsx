import { Button } from '@/components/ui/button';
import { SkeletonLines } from '@/components/patterns/states/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { describeReadError, isNotFound } from '@/lib/api/error-copy';

/** The loaded header's shape, so the connection lands without a jump. */
export function ConnectionLoading() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Skeleton shape="tile" className="size-10 shrink-0" />
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-32" />
        </div>
      </div>
      <SkeletonLines label="Loading this connection" lines={4} />
    </div>
  );
}

export function ConnectionUnreadable({
  error,
  retrying,
  onRetry,
}: Readonly<{
  error: unknown;
  retrying?: boolean;
  onRetry?: () => void;
}>) {
  const missing = isNotFound(error);
  return (
    <section
      aria-labelledby="connection-unreadable"
      className="flex flex-col gap-3"
    >
      <h2
        id="connection-unreadable"
        className="font-heading text-section font-semibold"
      >
        {missing ? 'Connection not found' : 'Connection'}
      </h2>
      <p className="text-sm text-muted-foreground">
        {missing
          ? 'This connection doesn’t exist, or you don’t have access to it.'
          : describeReadError(error, 'This connection')}
      </p>
      {onRetry === undefined ? null : (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={retrying}
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </section>
  );
}
