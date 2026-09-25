import { RotateCcwIcon } from 'lucide-react';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { describeReadError } from '@/lib/api/api-error-copy';

/**
 * The one feedback owner for a failed read. With nothing on screen it is a
 * destructive notice with Retry; with earlier data still shown it is the
 * amber "as of" line, and the data stays.
 */
export function ReadFailure({
  resource,
  error,
  showing,
  retrying,
  updatedAt,
  onRetry,
}: Readonly<{
  /** What failed to load, for the sentence: "Recent deliveries". */
  resource: string;
  error: unknown;
  /** Earlier data is still on screen. */
  showing: boolean;
  retrying: boolean;
  /** When the data on screen was fetched, in epoch milliseconds. */
  updatedAt: number;
  onRetry: () => void;
}>) {
  if (showing)
    return (
      <StaleLine updatedAt={updatedAt} retrying={retrying} onRetry={onRetry} />
    );
  return (
    <Notice
      tone="destructive"
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={onRetry}
        >
          <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
          Retry
        </Button>
      }
    >
      {describeReadError(error, resource)}
    </Notice>
  );
}
