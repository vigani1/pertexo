import type { ReactNode } from 'react';
import { CORE_IDLE_ENERGY, CoreOrb } from '@/components/patterns/core/orb';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { PlusIcon, RefreshCwIcon } from 'lucide-react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { buttonVariants } from '@/components/ui/button-variants';
import { ProgressButton } from '@/components/ui/progress-button';
import {
  LiveRunCounts,
  RunCount,
} from '@/features/workflow-runs/workflow-runs-views.public';
import type { RunStatistics } from '@/features/workflow-runs/workflow-runs-queries.public';
import { formatShortTime } from '@/lib/format/time';
import { homeGreeting } from '../model/home-greeting';

/**
 * The workspace's name and, in mono, exact figures from one statistics
 * snapshot: running, waiting and queued runs, failures in the last day and
 * when the server read them. Actions: New workflow and Refresh.
 */
export function HomeHeader({
  name,
  statistics,
  actions,
}: Readonly<{
  name: string | null;
  statistics: RunStatistics | undefined;
  actions: ReactNode;
}>) {
  return (
    <PageHeader>
      <div className="min-w-0 flex-1">
        <PageHeaderTitle
          size="hero"
          className="break-words [--display-width:78%] font-bold"
        >
          {homeGreeting(name, new Date().getHours())}
        </PageHeaderTitle>
        {/* Reserve the wrapped figures' height on a phone before the
            statistics arrive. */}
        <PageHeaderMeta
          className="max-md:min-h-14 max-md:content-start"
          aria-hidden={statistics === undefined ? true : undefined}
        >
          {statistics === undefined ? (
            '\u00a0'
          ) : (
            <>
              <LiveRunCounts current={statistics.current} />
              <RunCount
                tone="failure"
                count={statistics.window.byStatus.failed}
                label="failed in 24 h"
              />
              <span>as of {formatShortTime(statistics.asOf, 'h23')}</span>
            </>
          )}
        </PageHeaderMeta>
      </div>
      <CoreOrb
        state={(statistics?.current.running ?? 0) > 0 ? 'live' : 'idle'}
        energy={
          (statistics?.current.running ?? 0) > 0 ? 0.78 : CORE_IDLE_ENERGY
        }
        className="size-24 shrink-0 md:hidden"
      />
      {actions}
    </PageHeader>
  );
}

export function HomeHeaderActions({
  workspace,
  refreshing,
  onRefresh,
}: Readonly<{
  workspace: AccessibleWorkspace;
  refreshing: boolean;
  onRefresh: () => void;
}>) {
  return (
    <PageHeaderActions>
      <ProgressButton
        type="button"
        variant="ghost"
        size="sm"
        className="max-md:order-last"
        pending={refreshing}
        pendingLabel="Refreshing…"
        icon={<RefreshCwIcon data-icon="inline-start" aria-hidden="true" />}
        onClick={onRefresh}
      >
        Refresh
      </ProgressButton>
      {workspace.capabilities.includes('workflow:create') ? (
        <Link
          to="/w/$workspaceId/workflows"
          params={{ workspaceId: workspace.id }}
          search={{ create: true }}
          className={buttonVariants({ variant: 'primary' })}
        >
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          New workflow
        </Link>
      ) : null}
    </PageHeaderActions>
  );
}
