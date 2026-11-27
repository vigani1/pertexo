import { Link } from '@tanstack/react-router';
import { promotionSearch } from '@/features/workflow-promotions/public';
import type { WorkflowVersionResponse } from '@pertexo/contracts';
import {
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  EyeIcon,
  RotateCcwIcon,
  SendIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
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
  actions,
}: VersionTimelineProps) {
  const { onPreview, onRestore, onDuplicate, onExport } = actions;

  return (
    <ol
      aria-label="Published versions"
      // Narrow enough that each row's actions sit beside its version.
      className="relative flex max-w-3xl flex-col"
    >
      {versions.map((version) => {
        const live = version.id === liveVersionId;
        const label = `v${String(version.versionNumber)}`;
        return (
          <li key={version.id} className="row-divider">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg px-3 py-3 transition-colors hover:bg-select motion-reduce:transition-none">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <h3 className="text-lg leading-none font-semibold">
                    {label}
                  </h3>
                  {live ? (
                    <StatusMark tone="success">{liveLabel}</StatusMark>
                  ) : null}
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
              <VersionActions
                version={version}
                label={label}
                canRestore={canRestore}
                promotionWorkspaceId={promotionWorkspaceId}
                onPreview={onPreview}
                onRestore={onRestore}
                onDuplicate={onDuplicate}
                onExport={onExport}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

type VersionTimelineProps = Readonly<{
  versions: readonly WorkflowVersionResponse[];
  liveVersionId: string | null;
  liveLabel: string;
  canRestore: boolean;
  promotionWorkspaceId?: string;
  actions: Readonly<{
    onPreview: (version: WorkflowVersionResponse) => void;
    onRestore: (version: WorkflowVersionResponse) => void;
    onDuplicate?: ((version: WorkflowVersionResponse) => void) | undefined;
    onExport?: ((version: WorkflowVersionResponse) => void) | undefined;
  }>;
}>;

function VersionActions({
  version,
  label,
  canRestore,
  promotionWorkspaceId,
  onPreview,
  onRestore,
  onDuplicate,
  onExport,
}: Readonly<{
  version: WorkflowVersionResponse;
  label: string;
  promotionWorkspaceId: string | undefined;
}> &
  Pick<VersionTimelineProps, 'canRestore'> &
  VersionTimelineProps['actions']) {
  const menuUnavailable =
    promotionWorkspaceId === undefined &&
    onExport === undefined &&
    onDuplicate === undefined;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
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
          <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
          Restore to draft
        </Button>
      ) : null}
      {/* Rarer moves wait in one menu, so a row reads at a glance. */}
      {menuUnavailable ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`More for ${label}`}
            className={buttonVariants({
              variant: 'ghost',
              size: 'icon-sm',
            })}
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {promotionWorkspaceId === undefined ? null : (
                <DropdownMenuLinkItem
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
                  <SendIcon aria-hidden="true" />
                  Promote {label}…
                </DropdownMenuLinkItem>
              )}
              {onExport === undefined ? null : (
                <DropdownMenuItem
                  onClick={() => {
                    onExport(version);
                  }}
                >
                  <DownloadIcon aria-hidden="true" />
                  Export {label}
                </DropdownMenuItem>
              )}
              {onDuplicate === undefined ? null : (
                <DropdownMenuItem
                  onClick={() => {
                    onDuplicate(version);
                  }}
                >
                  <CopyIcon aria-hidden="true" />
                  Duplicate {label}
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
