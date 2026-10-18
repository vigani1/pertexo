import { Link } from '@tanstack/react-router';
import { promotionSearch } from '@/features/workflow-promotions/search.public';
import type { WorkflowVersionResponse } from '@pertexo/contracts';
import { CopyIcon, DownloadIcon, EyeIcon, RotateCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { cn } from '@/lib/utils';
import { stepCountLabel } from '../../model/versions/steps';

/**
 * Versions as knots on one vertical thread, newest first. The published
 * version's knot is tied (filled); the rest are loops on the thread.
 */
export function VersionTimeline({
  versions,
  liveVersionId,
  liveLabel,
  canRestore,
  promotionWorkspaceId,
  onPreview,
  onRestore,
  onDuplicate,
  onExport,
}: Readonly<{
  versions: readonly WorkflowVersionResponse[];
  liveVersionId: string | null;
  liveLabel: string;
  canRestore: boolean;
  promotionWorkspaceId?: string;
  onPreview: (version: WorkflowVersionResponse) => void;
  onRestore: (version: WorkflowVersionResponse) => void;
  onDuplicate?: ((version: WorkflowVersionResponse) => void) | undefined;
  onExport?: ((version: WorkflowVersionResponse) => void) | undefined;
}>) {
  return (
    <ol
      aria-label="Published versions"
      // Narrow enough that each row's actions sit beside its version.
      className="relative flex max-w-3xl flex-col"
    >
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
              </div>
              <div className="flex flex-wrap gap-1.5">
                {promotionWorkspaceId === undefined ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    render={
                      <Link
                        to="/w/$workspaceId/settings/promotion"
                        params={{ workspaceId: promotionWorkspaceId }}
                        search={promotionSearch([
                          {
                            workflowId: version.workflowId,
                            versionId: version.id,
                          },
                        ])}
                      />
                    }
                  >
                    Promote…
                  </Button>
                )}

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
                {onExport === undefined ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Export ${label}`}
                    onClick={() => {
                      onExport(version);
                    }}
                  >
                    <DownloadIcon aria-hidden="true" data-icon="inline-start" />
                    Export
                  </Button>
                )}
                {onDuplicate === undefined ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Duplicate ${label}`}
                    onClick={() => {
                      onDuplicate(version);
                    }}
                  >
                    <CopyIcon aria-hidden="true" data-icon="inline-start" />
                    Duplicate
                  </Button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
