import { Row } from '@/components/patterns/lists/row';
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
import {
  ATTENTION_WINDOW,
  type AttentionAction,
  type AttentionItem,
} from '../model/needs-attention';
import type { HomeBlockState } from '../model/home-block-state';
import { HomeBlock } from './home-block';

const PHONE_ATTENTION_PREVIEW = 3;

function ActionLink({
  action,
  workspace,
}: Readonly<{ action: AttentionAction; workspace: AccessibleWorkspace }>) {
  const workspaceId = workspace.id;
  const className = buttonVariants({
    size: 'sm',
    variant: 'outline',
    className:
      'h-auto max-w-40 py-2 text-center whitespace-normal wrap-anywhere',
  });
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
          {action.retryStep !== undefined &&
          workspace.status === 'active' &&
          workspace.capabilities.includes('run:replay')
            ? `Review retry from ${action.retryStep}`
            : 'Open run'}
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
          search={{ connection: action.connectionId }}
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
  /** The loaded problem runs do not cover the full statistics count. */
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
  if (!showAttention(items.length, state, moreWorkflows || moreFailedRuns))
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
            className="inline-flex items-center text-xs text-subtle-foreground hover:text-foreground pointer-coarse:min-h-10"
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
        {shown.map((item, index) => (
          <AttentionRow
            key={item.key}
            item={item}
            workspace={workspace}
            now={now}
            hideOnPhone={!expanded && index >= PHONE_ATTENTION_PREVIEW}
          />
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
      {!expanded &&
      items.length > PHONE_ATTENTION_PREVIEW &&
      items.length <= COLLAPSED_LIST_COUNT ? (
        <button
          type="button"
          aria-controls={listId}
          aria-expanded={false}
          onClick={() => {
            setExpanded(true);
          }}
          className="min-h-10 text-sm text-accent-foreground md:hidden"
        >
          Show all {items.length}
        </button>
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
          Some problem runs from {ATTENTION_WINDOW} aren’t listed.
        </p>
      ) : null}
    </HomeBlock>
  );
}

function showAttention(count: number, state: HomeBlockState, more: boolean) {
  return count > 0 || state.failed || (state.pending && !state.hasData) || more;
}

function AttentionRow({
  item,
  workspace,
  now,
  hideOnPhone,
}: Readonly<{
  item: AttentionItem;
  workspace: AccessibleWorkspace;
  now: number;
  hideOnPhone: boolean;
}>) {
  return (
    <Row
      frame="bare"
      lift="none"
      transition="none"
      className={`grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 py-3 ${hideOnPhone ? 'max-md:hidden' : ''}`}
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
        <ActionLink action={item.action} workspace={workspace} />
      )}
    </Row>
  );
}
