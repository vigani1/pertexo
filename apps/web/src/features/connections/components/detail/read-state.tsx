import { Button } from '@/components/ui/button';
import {
  SheetBody,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton, SkeletonLines } from '@/components/ui/skeleton';
import { describeReadError, isNotFound } from '@/lib/api/error-copy';

/** The loaded header's shape, so the connection lands without a jump. */
export function ConnectionLoading() {
  return (
    <>
      <SheetHeader className="flex-row items-center gap-3">
        <Skeleton className="size-10 shrink-0 rounded-lg" />
        <div className="min-w-0">
          <SheetTitle>Connection</SheetTitle>
          <Skeleton className="my-[3px] h-3.5 w-32" />
        </div>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-3">
        <SkeletonLines label="Loading this connection" lines={4} />
      </SheetBody>
    </>
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
    <>
      <SheetHeader>
        <SheetTitle>
          {missing ? 'Connection not found' : 'Connection'}
        </SheetTitle>
        <SheetDescription>
          {missing
            ? 'This connection doesn’t exist, or you don’t have access to it.'
            : describeReadError(error, 'This connection')}
        </SheetDescription>
      </SheetHeader>
      {onRetry === undefined ? null : (
        <SheetBody className="flex flex-col gap-3">
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={retrying}
            onClick={onRetry}
          >
            Retry
          </Button>
        </SheetBody>
      )}
    </>
  );
}
