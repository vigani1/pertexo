import { Link } from '@tanstack/react-router';
import { Row, RowList } from '@/components/patterns/lists/row';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { formatDateTime, formatMoment } from '@/lib/format/time';
import {
  publisherLabel,
  type HistoryVersion,
} from '../../model/versions/history';

/**
 * The draft, then every published version, newest first. Choosing a version
 * shows it beside the list; the draft opens in Build.
 */
export function VersionList({
  versions,
  liveVersionId,
  liveLabel,
  selectedId,
  onSelect,
  draftLink,
}: Readonly<{
  versions: readonly HistoryVersion[];
  liveVersionId: string | null;
  liveLabel: string;
  selectedId: string | undefined;
  onSelect: (version: HistoryVersion) => void;
  draftLink: Readonly<{ workspaceId: string; workflowId: string }>;
}>) {
  return (
    <nav aria-label="Versions" className="flex flex-col">
      <RuleHeading count={versions.length}>Versions</RuleHeading>
      <RowList className="mt-2">
        <Row className="p-0">
          <Link
            to="/w/$workspaceId/workflows/$workflowId"
            params={draftLink}
            className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3 rounded-lg px-3.5 py-3 outline-none focus-ring"
          >
            <StatusMark tone="neutral" display="mark" />
            <span className="min-w-0">
              <span className="block text-lead font-semibold">Draft</span>
              <span className="block text-meta text-subtle-foreground">
                Edit it in Build, then publish
              </span>
            </span>
          </Link>
        </Row>
        {versions.map((version) => {
          const live = version.id === liveVersionId;
          const selected = version.id === selectedId;
          return (
            <Row key={version.id} selected={selected} className="p-0">
              <button
                type="button"
                aria-current={selected ? 'true' : undefined}
                className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3 rounded-lg px-3.5 py-3 text-left outline-none focus-ring"
                onClick={() => {
                  onSelect(version);
                }}
              >
                <StatusMark tone={live ? 'success' : 'off'} display="mark" />
                <span className="min-w-0">
                  <span className="block text-lead font-semibold">
                    v{String(version.versionNumber)}
                    {live ? ' ' : null}
                    {live ? (
                      <span className="ml-1 text-meta font-normal text-subtle-foreground">
                        {liveLabel.toLowerCase()}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-meta text-subtle-foreground">
                    <time
                      dateTime={version.publishedAt}
                      title={formatDateTime(version.publishedAt)}
                    >
                      {formatMoment(version.publishedAt)}
                    </time>{' '}
                    · {publisherLabel(version)}
                  </span>
                </span>
              </button>
            </Row>
          );
        })}
      </RowList>
    </nav>
  );
}
