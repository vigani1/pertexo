import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { CLOCK_TICK, useNow } from '@/lib/hooks/use-now';
import { useId, useState } from 'react';
import { SearchInput } from '@/components/ui/input';
import {
  COLLAPSED_LIST_COUNT,
  SEARCH_LIST_THRESHOLD,
  ShowAll,
} from '@/components/patterns/lists/show-all';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { StatusMark } from '@/components/patterns/status/status-mark';
import type { AttentionAction, AttentionItem } from '../model/needs-attention';
import type { HomeBlockState } from '../model/home-block-state';
import { HomeBlock } from './home-block';

function ActionLink({
  action,
  workspaceId,
}: Readonly<{ action: AttentionAction; workspaceId: string }>) {
  const className = buttonVariants({ size: 'sm', variant: 'outline' });
  switch (action.kind) {
    case 'task':
      return (
        <Link
          to="/w/$workspaceId/requests/$taskId"
          params={{ workspaceId, taskId: action.taskId }}
          className={className}
        >
          Review
        </Link>
      );
    case 'run':
      return (
        <Link
          to="/w/$workspaceId/runs/$runId"
          params={{ workspaceId, runId: action.runId }}
          className={className}
        >
          Open run
        </Link>
      );
    case 'triggers':
      return (
        <Link
          to="/w/$workspaceId/workflows/$workflowId/triggers"
          params={{ workspaceId, workflowId: action.workflowId }}
          className={className}
        >
          Check triggers
        </Link>
      );
    case 'connections':
      return (
        <Link
          to="/w/$workspaceId/connections"
          params={{ workspaceId }}
          className={className}
        >
          Reconnect
        </Link>
      );
    case 'alerts':
      return (
        <Link
          to="/w/$workspaceId/settings/alerts"
          params={{ workspaceId }}
          className={className}
        >
          Review
        </Link>
      );
  }
}

export function NeedsAttention({
  workspace,
  items,
  state,
  moreFailedRuns,
  moreWorkflows = false,
}: Readonly<{
  workspace: AccessibleWorkspace;
  items: readonly AttentionItem[];
  state: HomeBlockState;
  /** Some problem-run reads hit their page limit. */
  moreFailedRuns: boolean;
  moreWorkflows?: boolean;
}>) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const now = useNow({
    intervalMs: CLOCK_TICK.relativeTime,
    enabled: items.some((item) => item.deadline !== undefined),
  });
  // Nothing needs you: the block is gone, not an empty promise. Partial
  // evidence still shows, so its gap is said.
  const loading = state.pending && !state.hasData;
  if (items.length === 0 && !state.failed && !loading && !moreWorkflows)
    return null;
  const needle = search.trim().toLocaleLowerCase();
  const filtered =
    needle === ''
      ? items
      : items.filter((item) =>
          `${item.title} ${item.detail}`.toLocaleLowerCase().includes(needle),
        );
  const shown = expanded ? filtered : filtered.slice(0, COLLAPSED_LIST_COUNT);
  const canReadRuns = workspace.capabilities.includes('run:read');
  return (
    <HomeBlock
      title="Needs you"
      headingId="home-attention-title"
      count={items.length === 0 ? undefined : items.length}
      state={state}
      actions={
        canReadRuns ? (
          <Link
            to="/w/$workspaceId/runs"
            params={{ workspaceId: workspace.id }}
            search={{ status: 'failed' }}
            className="text-xs text-subtle-foreground hover:text-foreground"
          >
            Failed runs
          </Link>
        ) : undefined
      }
    >
      {expanded && items.length > SEARCH_LIST_THRESHOLD ? (
        <SearchInput
          aria-label="Search items needing attention"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      ) : null}
      <ul id={listId} aria-label="Needs you" className="flex flex-col">
        {shown.map((item) => (
          <li
            key={item.key}
            className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 row-divider py-3"
          >
            <StatusMark display="mark" tone={item.tone} />
            <div className="min-w-0">
              <p className="line-clamp-2 text-sm font-semibold">{item.title}</p>
              <p className="mt-0.5 line-clamp-2 text-xs text-subtle-foreground">
                {item.detail}
                {item.deadline === undefined ? null : (
                  <>
                    {' '}
                    ·{' '}
                    <time
                      dateTime={item.deadline}
                      title={formatDateTime(item.deadline)}
                    >
                      Expires {formatRelativeTime(item.deadline, now, 'long')}
                    </time>
                  </>
                )}
              </p>
            </div>
            {item.action === undefined ? (
              <span />
            ) : (
              <ActionLink action={item.action} workspaceId={workspace.id} />
            )}
          </li>
        ))}
      </ul>
      {moreWorkflows ? (
        <p className="border-t border-surface-ink/6 pt-2 text-xs text-subtle-foreground">
          <span>
            Only loaded workflows were checked. Older workflows may need
            attention.
          </span>{' '}
          <Link
            to="/w/$workspaceId/workflows"
            params={{ workspaceId: workspace.id }}
            className="underline"
          >
            Review all workflows
          </Link>
        </p>
      ) : null}
      {items.length > 0 && shown.length === 0 ? (
        <p className="py-3 text-muted-foreground">
          No items match your search.
        </p>
      ) : null}
      <ShowAll
        count={items.length}
        controls={listId}
        expanded={expanded}
        onExpandedChange={(next) => {
          setExpanded(next);
          if (!next) setSearch('');
        }}
      />
      {moreFailedRuns ? (
        <p className="border-t border-border pt-2 text-xs text-subtle-foreground">
          Counting the latest 100 problem runs of each kind.
        </p>
      ) : null}
    </HomeBlock>
  );
}
