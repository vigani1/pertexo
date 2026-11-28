import { Link } from '@tanstack/react-router';
import {
  DetailRowControl,
  Row,
  RowList,
} from '@/components/patterns/lists/row';
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
      <RuleHeading count={versions.length + 1}>Versions</RuleHeading>
      <RowList className="mt-2">
        <Row frame="bare">
          <DetailRowControl
            render={
              <Link
                to="/w/$workspaceId/workflows/$workflowId"
                params={draftLink}
              />
            }
          >
            <StatusMark tone="neutral" display="mark" />
            <span className="min-w-0">
              <span className="block text-lead font-semibold">
                {versions[0] === undefined
                  ? 'Draft'
                  : `Draft · candidate v${String(versions[0].versionNumber + 1)}`}
              </span>
              <span className="block text-meta text-subtle-foreground">
                Edit it in Build, then publish
              </span>
            </span>
          </DetailRowControl>
        </Row>
        {versions.map((version) => {
          const live = version.id === liveVersionId;
          const selected = version.id === selectedId;
          return (
            <Row key={version.id} selected={selected} frame="bare">
              <DetailRowControl
                type="button"
                aria-current={selected ? 'true' : undefined}
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
              </DetailRowControl>
            </Row>
          );
        })}
      </RowList>
    </nav>
  );
}
