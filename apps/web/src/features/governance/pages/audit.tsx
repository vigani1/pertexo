import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { DownloadIcon } from 'lucide-react';
import type { AccessibleWorkspace, AuditFilter } from '@pertexo/contracts';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { RecentLog } from '@/components/patterns/lists/recent-log';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { describeCommandError } from '@/lib/api/error-copy';
import { GovernanceSettings } from '../components/settings';
import { AuditFilters } from '../components/filters';
import { AuditEntry } from '../components/entry';
import { auditQueryOptions } from '../data/audit.queries';
import { exportAudit, type GovernanceScope } from '../data/audit.api';
import { auditActionWords } from '../model/ledger';
import { whoCan } from '@/features/workspaces/roles.public';

/** Who changed what, read as sentences, newest first and grouped by day. */
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
  const [downloadError, setDownloadError] = useState<string>();
  if (!allowed)
    return (
      <div className="flex min-w-0 max-w-4xl flex-col gap-8">
        <PageHeader>
          <PageHeaderTitle>Audit log</PageHeaderTitle>
        </PageHeader>
        <Notice>
          Only workspace {whoCan('audit:read')} can read the audit log.
        </Notice>
      </div>
    );
  const entries = events.data?.pages.flatMap((page) => page.items);
  const actionWords =
    filters.action === undefined ? undefined : auditActionWords(filters.action);
  const narrowed = Object.keys(filters).length > 0;
  return (
    <div className="flex min-w-0 max-w-4xl flex-col gap-8">
      <PageHeader>
        <div>
          <PageHeaderTitle>Audit log</PageHeaderTitle>
          <PageHeaderMeta>
            <span>Who changed what in this workspace</span>
          </PageHeaderMeta>
        </div>
        <PageHeaderActions>
          <Button
            type="button"
            variant="outline"
            size="sm"
            title="Up to 100,000 matching events as a file"
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
            <DownloadIcon aria-hidden="true" data-icon="inline-start" />
            {narrowed ? 'Export these events' : 'Export'}
          </Button>
        </PageHeaderActions>
      </PageHeader>
      {downloadError === undefined ? null : (
        <Notice tone="warning">{downloadError}</Notice>
      )}
      <AuditFilters
        key={JSON.stringify(filters)}
        filters={filters}
        {...(actionWords === undefined ? {} : { actionWords })}
        onApply={onFilter}
      />
      <RecentLog
        headingLevel="h2"
        query={events}
        items={entries}
        itemKey={(event) => event.id}
        dayOf={(event) => event.occurredAt}
        renderItem={(event) => (
          <AuditEntry
            workspaceId={workspace.id}
            event={event}
            onOnlyAction={(action) => {
              onFilter({ ...filters, action });
            }}
            onOnlyTarget={(targetType, targetId) => {
              onFilter({ ...filters, targetType, targetId });
            }}
          />
        )}
        copy={{
          title: 'Events',
          subject: 'audit events',
          loadMoreLabel: 'Load older events',
          empty: narrowed
            ? 'Nothing matches. Widen the dates or clear a filter.'
            : 'Nothing has changed yet. Publishing, sign-ins and changes to people, connections and settings appear here.',
        }}
      />
      {/* Below the log and only once it has loaded, so the settings never
          appear first and then get pushed down by arriving events. */}
      {events.isPending ? null : (
        <div className="flex flex-col">
          <GovernanceSettings scope={scope} workspace={workspace} />
        </div>
      )}
    </div>
  );
}
