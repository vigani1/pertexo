import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import { formatClock } from '@/lib/format-time';
import { cn } from '@/lib/utils';

/**
 * A background refresh failed: the data stays on screen and one amber line
 * says how old it is, with Retry. Never blank a page for a failed refetch.
 */
export function StaleLine({
  updatedAt,
  retrying,
  onRetry,
  className,
}: Readonly<{
  /** When the data on screen was fetched, in epoch milliseconds. */
  updatedAt: number;
  retrying: boolean;
  onRetry: () => void;
  className?: string;
}>) {
  return (
    <div
      role="alert"
      data-slot="stale-line"
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-warning',
        className,
      )}
    >
      <StatusGlyph tone="attention" />
      <span>
        Couldn’t refresh. Showing results from{' '}
        <span className="font-mono">
          {formatClock(new Date(updatedAt).toISOString())}
        </span>
        .
      </span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="text-warning"
        disabled={retrying}
        onClick={onRetry}
      >
        <RefreshCwIcon aria-hidden="true" />
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  );
}
