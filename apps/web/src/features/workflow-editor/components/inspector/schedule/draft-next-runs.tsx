import { RotateCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScheduleRunTimes } from '@/features/catalog/presentation.public';
import { useSchedulePreview } from '@/features/workflow-publish/schedule-preview.public';
import type { ScheduleRecurrence } from '../../../model/schedule-draft';

/**
 * The next three run times of the rule on screen if it were published now,
 * worked out by the server's scheduler (timezone and DST included). Shown
 * only for a finished rule, and only where the editor can ask the server.
 */
export function DraftNextRuns({
  recurrence,
}: Readonly<{ recurrence: ScheduleRecurrence | undefined }>) {
  const preview = useSchedulePreview(recurrence);
  if (preview.status === 'unavailable') return null;
  return (
    <div className="mt-3 flex flex-col gap-1.5 border-t border-white/7 pt-2.5">
      <p className="text-xs font-medium text-muted-foreground">
        Next runs if published now
      </p>
      {preview.status === 'loading' ? (
        <div
          role="status"
          aria-label="Working out the next runs"
          className="flex flex-col gap-2 py-1"
        >
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-3 w-3/5" />
          ))}
        </div>
      ) : null}
      {preview.status === 'failed' ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-destructive"
        >
          <span>{preview.message}</span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={preview.retry}
          >
            <RotateCcwIcon aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}
      {preview.status === 'ready' ? (
        <ScheduleRunTimes
          label="Next runs if published now"
          times={preview.times}
          {...(recurrence?.kind === 'cron'
            ? { timezone: recurrence.timezone }
            : {})}
        />
      ) : null}
    </div>
  );
}
