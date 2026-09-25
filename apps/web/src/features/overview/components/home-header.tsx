import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { RefreshCwIcon } from 'lucide-react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { ProgressButton } from '@/components/ui/progress-button';
import { LiveRunCounts, RunCount } from '@/features/workflow-runs/loom.public';
import type { RunStatistics } from '@/features/workflow-runs/queries.public';
import { formatClock } from '@/lib/format-time';

/**
 * The workspace's name and, in mono, exact figures from one statistics
 * snapshot: running, waiting and queued runs, failures in the last day and
 * when the server read them.
 */
export function HomeHeader({
  workspace,
  statistics,
  refreshing,
  onRefresh,
}: Readonly<{
  workspace: AccessibleWorkspace;
  statistics: RunStatistics | undefined;
  refreshing: boolean;
  onRefresh: () => void;
}>) {
  return (
    <PageHeader>
      <div className="min-w-0">
        <PageHeaderTitle className="break-words sm:text-5xl">
          {workspace.name}
        </PageHeaderTitle>
        {statistics === undefined ? null : (
          <PageHeaderMeta>
            <LiveRunCounts current={statistics.current} />
            <RunCount
              tone="failure"
              count={statistics.window.byStatus.failed}
              label="failed in 24 h"
            />
            <span>as of {formatClock(statistics.asOf)}</span>
          </PageHeaderMeta>
        )}
      </div>
      <PageHeaderActions>
        <ProgressButton
          type="button"
          variant="ghost"
          pending={refreshing}
          pendingLabel="Refreshing…"
          icon={<RefreshCwIcon data-icon="inline-start" aria-hidden="true" />}
          onClick={onRefresh}
        >
          Refresh
        </ProgressButton>
      </PageHeaderActions>
    </PageHeader>
  );
}
