import { Link } from '@tanstack/react-router';
import {
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  EyeIcon,
  SendIcon,
} from 'lucide-react';
import { promotionSearch } from '@/features/workflow-promotions/public';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { StatusMark } from '@/components/patterns/status/status-mark';
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
import { formatDateTime } from '@/lib/format/time';
import {
  shortChecksum,
  publisherLabel,
  type HistoryVersion,
} from '../../model/versions/history';
import { stepCountLabel } from '../../model/versions/steps';
import { VersionDiffSummary } from './diff-summary';

type VersionActions = Readonly<{
  onPreview: (version: HistoryVersion) => void;
  onRestore: ((version: HistoryVersion) => void) | undefined;
  onCompare: ((version: HistoryVersion) => void) | undefined;
  onDuplicate: ((version: HistoryVersion) => void) | undefined;
  onExport: ((version: HistoryVersion) => void) | undefined;
  promotionWorkspaceId: string | undefined;
}>;

/**
 * One published version: when and by whom, its actions, and what changed
 * from the version before it.
 */
export function VersionDetail({
  version,
  previous,
  newer,
  live,
  liveLabel,
  actions,
}: Readonly<{
  version: HistoryVersion;
  previous: HistoryVersion | undefined;
  newer: HistoryVersion | undefined;
  live: HistoryVersion | undefined;
  liveLabel: string;
  actions: VersionActions;
}>) {
  const label = `v${String(version.versionNumber)}`;
  const isLive = live?.id === version.id;
  return (
    <article aria-labelledby="version-detail" className="flex flex-col">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <h2
          id="version-detail"
          className="font-display text-display leading-none"
        >
          {label}
        </h2>
        {live === undefined ? null : (
          <StatusMark tone={isLive ? 'success' : 'off'}>
            {versionStatus({ version, live, newer, liveLabel })}
          </StatusMark>
        )}
      </div>
      <p className="mt-3 text-meta text-subtle-foreground">
        Published{' '}
        <time dateTime={version.publishedAt}>
          {formatDateTime(version.publishedAt)}
        </time>{' '}
        by {publisherLabel(version)} ·{' '}
        {stepCountLabel(version.graph.nodes.length)}
      </p>
      <p className="mt-1 truncate font-mono text-caption text-subtle-foreground">
        checksum {shortChecksum(version.checksum)}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {actions.onRestore === undefined ? null : (
          <Button
            type="button"
            onClick={() => {
              actions.onRestore?.(version);
            }}
          >
            Restore to draft
          </Button>
        )}
        {actions.onCompare === undefined || isLive ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              actions.onCompare?.(version);
            }}
          >
            {live === undefined
              ? 'Compare versions'
              : `Compare with ${liveLabel.toLowerCase()}`}
          </Button>
        )}
        <MoreActions version={version} label={label} actions={actions} />
      </div>
      {actions.onRestore === undefined ? null : (
        <p className="mt-2.5 text-meta text-subtle-foreground">
          Restoring replaces your draft.
          {live === undefined || isLive
            ? null
            : ` Live v${String(live.versionNumber)} keeps running until you publish.`}
        </p>
      )}
      <section
        aria-labelledby="version-changes"
        className="mt-10 flex flex-col gap-2"
      >
        <RuleHeading id="version-changes" appearance="compact">
          {previous === undefined
            ? 'The first version'
            : `What changed from v${String(previous.versionNumber)}`}
        </RuleHeading>
        {previous === undefined ? (
          <p className="text-sm text-muted-foreground">
            The first published version of this workflow.
          </p>
        ) : (
          <VersionDiffSummary from={previous} to={version} />
        )}
      </section>
    </article>
  );
}

function versionStatus({
  version,
  live,
  newer,
  liveLabel,
}: Readonly<{
  version: HistoryVersion;
  live: HistoryVersion;
  newer: HistoryVersion | undefined;
  liveLabel: string;
}>) {
  if (version.id === live.id) return liveLabel;
  if (version.versionNumber >= live.versionNumber) return 'Not live';
  return newer === undefined
    ? 'Retired'
    : `Retired when v${String(newer.versionNumber)} was published`;
}

/** The rarer moves wait in one menu, so the actions read at a glance. */
function MoreActions({
  version,
  label,
  actions,
}: Readonly<{
  version: HistoryVersion;
  label: string;
  actions: VersionActions;
}>) {
  const { promotionWorkspaceId, onExport, onDuplicate } = actions;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`More for ${label}`}
        className={buttonVariants({ variant: 'ghost', size: 'icon' })}
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => {
              actions.onPreview(version);
            }}
          >
            <EyeIcon aria-hidden="true" />
            Preview
          </DropdownMenuItem>
          {promotionWorkspaceId === undefined ? null : (
            <DropdownMenuLinkItem
              render={
                <Link
                  to="/w/$workspaceId/settings/promotion"
                  params={{ workspaceId: promotionWorkspaceId }}
                  search={promotionSearch([
                    { workflowId: version.workflowId, versionId: version.id },
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
  );
}
