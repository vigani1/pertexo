import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { RefreshCwIcon } from 'lucide-react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { LiveRunCounts, RunCount } from '@/features/workflow-runs/loom.public';
import type {
  AttentionRuns,
  RunStatusCounts,
} from '@/features/workflow-runs/queries.public';
import { formatClock } from '@/lib/format-time';

/**
 * The workspace's name and, in mono, what is happening right now: running,
 * waiting and queued runs, failures in the last day and when that was read.
 */
export function HomeHeader({
  workspace,
  counts,
  attention,
  countsUpdatedAt,
  refreshing,
  onRefresh,
}: Readonly<{
  workspace: AccessibleWorkspace;
  counts: RunStatusCounts | undefined;
  attention: AttentionRuns | undefined;
  countsUpdatedAt: number;
  refreshing: boolean;
  onRefresh: () => void;
}>) {
  return (
    <PageHeader>
      <div className="min-w-0">
        <PageHeaderTitle className="break-words sm:text-5xl">
          {workspace.name}
        </PageHeaderTitle>
        <PageHeaderMeta>
          {counts === undefined ? null : <LiveRunCounts counts={counts} />}
          {attention === undefined ? null : (
            <RunCount
              tone="failure"
              sample={attention.failed}
              label="failed in 24 h"
            />
          )}
          {countsUpdatedAt > 0 ? (
            <span>
              as of {formatClock(new Date(countsUpdatedAt).toISOString())}
            </span>
          ) : null}
        </PageHeaderMeta>
      </div>
      <PageHeaderActions>
        <Button
          type="button"
          variant="ghost"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {refreshing ? <LoadingOrb /> : <RefreshCwIcon aria-hidden="true" />}
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </PageHeaderActions>
    </PageHeader>
  );
}
