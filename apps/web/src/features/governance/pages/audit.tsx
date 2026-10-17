import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace, AuditFilter } from '@pertexo/contracts';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { SettingsSection } from '@/components/patterns/settings-section';
import { LoadMore } from '@/components/patterns/load-more';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { StatusGlyph } from '@/components/ui/status';
import { formatDateTime } from '@/lib/format/time';
import { describeCommandError } from '@/lib/api/error-copy';
import { AuditFilters } from '../components/filters';
import { AuditRetention } from '../components/retention';
import {
  auditQueryOptions,
  governanceQueryOptions,
} from '../data/audit.queries';
import { exportAudit, type GovernanceScope } from '../data/audit.api';
export function AuditPage({
  scope,
  workspace,
  filters,
  onFilter,
}: Readonly<{
  scope: GovernanceScope;
  workspace: AccessibleWorkspace;
  filters: AuditFilter;
  onFilter: (filters: AuditFilter) => void;
}>) {
  const allowed = workspace.capabilities.includes('audit:read');
  const events = useInfiniteQuery({
    ...auditQueryOptions(scope, filters),
    enabled: allowed,
  });
  const settings = useQuery({
    ...governanceQueryOptions(scope),
    enabled: allowed,
  });
  const [downloadError, setDownloadError] = useState<string>();
  if (!allowed)
    return (
      <Notice>Only workspace owners and admins can read the audit log.</Notice>
    );
  const entries = events.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="flex min-w-0 max-w-5xl flex-col gap-6">
      <PageHeader>
        <PageHeaderTitle>Audit log</PageHeaderTitle>
      </PageHeader>
      <p className="flex items-center gap-2 border-y border-border py-4 text-sm text-muted-foreground">
        <StatusGlyph tone="neutral" />A record of who changed what. Metadata
        only.
      </p>
      <SettingsSection
        title="Find events"
        description="Filter by person, action, target or UTC date range. The newest events appear first."
      >
        <AuditFilters
          key={JSON.stringify(filters)}
          filters={filters}
          onApply={onFilter}
        />
        <div className="mt-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDownloadError(undefined);
              try {
                exportAudit(scope, filters);
              } catch (error) {
                setDownloadError(
                  describeCommandError(error, 'starting the audit download'),
                );
              }
            }}
          >
            Export matching events
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Up to 100,000 events per download. Choose a narrower date range for
          larger logs. Your browser reports interrupted downloads. Changes
          during an export may be absent.
        </p>
        {downloadError === undefined ? null : (
          <Notice tone="warning">{downloadError}</Notice>
        )}
      </SettingsSection>
      <section aria-label="Audit events">
        {events.isPending ? <p role="status">Loading audit events…</p> : null}
        {events.isError && entries.length === 0 ? (
          <Notice
            tone="warning"
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => void events.refetch()}
              >
                Retry
              </Button>
            }
          >
            Audit events could not be loaded.
          </Notice>
        ) : null}
        {!events.isPending && !events.isError && entries.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No events match these filters.
          </p>
        ) : null}
        <ol className="divide-y divide-border">
          {entries.map((event) => (
            <li key={event.id} className="flex min-w-0 gap-3 py-4">
              <StatusGlyph tone="neutral" className="mt-1 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium [overflow-wrap:anywhere]">
                  {event.actorName ??
                    (event.actorId === null ? 'System' : 'Former member')}{' '}
                  <span className="font-normal text-muted-foreground">
                    {event.action}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {event.targetType}
                  {event.targetId === null ? '' : `: ${event.targetId}`}
                </p>
                <time
                  className="block text-xs text-muted-foreground"
                  dateTime={event.occurredAt}
                >
                  {formatDateTime(event.occurredAt)}
                </time>
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer py-1">
                    Event details
                  </summary>
                  <dl className="space-y-1 py-2 [overflow-wrap:anywhere]">
                    <div>
                      <dt className="inline">Event ID: </dt>
                      <dd className="inline">{event.id}</dd>
                    </div>
                    {event.actorId === null ? null : (
                      <div>
                        <dt className="inline">Person ID: </dt>
                        <dd className="inline">{event.actorId}</dd>
                      </div>
                    )}
                    {Object.entries(event.metadata).map(([name, value]) => (
                      <div key={name}>
                        <dt className="inline">{name}: </dt>
                        <dd className="inline">{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </div>
            </li>
          ))}
        </ol>
        <LoadMore
          subject="audit events"
          hasNextPage={events.hasNextPage}
          loading={events.isFetchingNextPage}
          failed={events.isFetchNextPageError}
          onLoadMore={() => {
            if (!events.isFetching) void events.fetchNextPage();
          }}
        />
      </section>
      <SettingsSection
        title="Audit retention"
        description="Owners and admins can keep events for 30 to 2,555 days. Run data retention is separate."
      >
        {settings.isError ? (
          <Notice
            tone="warning"
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => void settings.refetch()}
              >
                Retry settings
              </Button>
            }
          >
            Retention settings could not be loaded.
          </Notice>
        ) : settings.data === undefined ? (
          <p role="status">Loading retention…</p>
        ) : (
          <AuditRetention
            scope={scope}
            snapshot={settings.data}
            editable={
              workspace.status === 'active' &&
              workspace.capabilities.includes('governance:manage')
            }
          />
        )}
      </SettingsSection>
    </div>
  );
}
