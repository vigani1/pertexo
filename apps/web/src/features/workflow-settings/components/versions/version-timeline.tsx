import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { EyeIcon, RotateCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { stepCountLabel } from '../../model/version-steps';

/**
 * Versions as knots on one vertical thread, newest first. The published
 * version's knot is tied (filled); the rest are loops on the thread.
 */
export function VersionTimeline({
  versions,
  liveVersionId,
  liveLabel,
  canRestore,
  onPreview,
  onRestore,
}: Readonly<{
  versions: readonly WorkflowVersionResponse[];
  liveVersionId: string | null;
  liveLabel: string;
  canRestore: boolean;
  onPreview: (version: WorkflowVersionResponse) => void;
  onRestore: (version: WorkflowVersionResponse) => void;
}>) {
  return (
    <ol aria-label="Published versions" className="relative flex flex-col">
      <span
        aria-hidden="true"
        className="absolute top-4 bottom-4 left-[0.4375rem] w-px bg-linear-to-b from-accent-foreground/45 via-border-strong to-transparent"
      />
      {versions.map((version) => {
        const live = version.id === liveVersionId;
        const label = `v${String(version.versionNumber)}`;
        return (
          <li
            key={version.id}
            className="relative grid grid-cols-[0.9rem_minmax(0,1fr)] gap-x-4"
          >
            <span
              aria-hidden="true"
              className={cn(
                'relative z-10 mt-4 size-3.5 rounded-full border-2 bg-background',
                live
                  ? 'border-success bg-success shadow-[0_0_10px_var(--success)]'
                  : 'border-accent-foreground/50',
              )}
            />
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg px-3 py-3 transition-colors hover:bg-white/[0.03] motion-reduce:transition-none">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <h3 className="text-lg leading-none font-semibold">
                    {label}
                  </h3>
                  {live ? <Status tone="success">{liveLabel}</Status> : null}
                </div>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  Published{' '}
                  <time
                    dateTime={version.publishedAt}
                    title={formatDateTime(version.publishedAt)}
                  >
                    {formatRelativeTime(version.publishedAt)}
                  </time>{' '}
                  · {stepCountLabel(version.graph.nodes.length)}
                </p>
                <p className="mt-0.5 font-mono text-[0.72rem] text-subtle-foreground">
                  {formatDateTime(version.publishedAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Preview ${label}`}
                  onClick={() => {
                    onPreview(version);
                  }}
                >
                  <EyeIcon aria-hidden="true" data-icon="inline-start" />
                  Preview
                </Button>
                {canRestore ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onRestore(version);
                    }}
                  >
                    <RotateCcwIcon
                      aria-hidden="true"
                      data-icon="inline-start"
                    />
                    Restore to draft
                  </Button>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
