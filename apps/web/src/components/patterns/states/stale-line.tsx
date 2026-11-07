import { ReadRecovery } from './read-recovery';
import type { ReactNode } from 'react';
import { StatusGlyph } from '@/components/ui/status';
import { formatShortTime } from '@/lib/format/time';
import { cn } from '@/lib/class-names';

/**
 * A background refresh failed: the data stays on screen and one amber line
 * says how old it is, with Retry. Never blank a page for a failed refetch.
 * `children` adds one short sentence, e.g. that unsaved edits are kept.
 */
export function StaleLine({
  error,
  updatedAt,
  retrying,
  onRetry,
  className,
  children,
}: Readonly<{
  /** When the data on screen was fetched, in epoch milliseconds. */
  error?: unknown;
  updatedAt: number;
  retrying: boolean;
  onRetry: () => void;
  className?: string;
  children?: ReactNode;
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
        <time
          dateTime={new Date(updatedAt).toISOString()}
          className="font-mono"
        >
          {formatShortTime(updatedAt)}
        </time>
        .{children === undefined ? null : <> {children}</>}
      </span>
      <ReadRecovery
        error={error}
        resource="Latest results"
        retrying={retrying}
        retry={onRetry}
        message={null}
        pendingLabel="Retrying…"
      />
    </div>
  );
}
