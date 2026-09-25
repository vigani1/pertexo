import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { StatusGlyph } from '@/components/ui/status';
import type { AttentionAction, AttentionItem } from '../model/needs-attention';
import type { HomeBlockState } from '../model/home-block-state';
import { HomeBlock } from './home-block';

/** How many items Needs attention shows before "… more not shown". */
export const NEEDS_ATTENTION_LIMIT = 6;

function ActionLink({
  action,
  workspaceId,
}: Readonly<{ action: AttentionAction; workspaceId: string }>) {
  const className = buttonVariants({ size: 'sm', variant: 'outline' });
  switch (action.kind) {
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
          to="/w/$workspaceId/alerts"
          params={{ workspaceId }}
          className={className}
        >
          Review
        </Link>
      );
  }
}

/**
 * What needs someone: failed or uncertain runs, unhealthy triggers,
 * connections to reconnect and alerts that are off. One knotted "All clear"
 * when nothing does.
 */
export function NeedsAttention({
  workspace,
  items,
  state,
  moreFailedRuns,
}: Readonly<{
  workspace: AccessibleWorkspace;
  items: readonly AttentionItem[];
  state: HomeBlockState;
  /** Some problem-run reads hit their page limit. */
  moreFailedRuns: boolean;
}>) {
  const shown = items.slice(0, NEEDS_ATTENTION_LIMIT);
  const canReadRuns = workspace.capabilities.includes('run:read');
  return (
    <HomeBlock
      title="Needs attention"
      headingId="home-attention-title"
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
      {shown.length === 0 ? (
        <div className="flex items-center gap-3 border-t border-white/6 py-3.5">
          <StatusGlyph tone="success" />
          <p className="text-sm">
            <span className="font-semibold">All clear.</span>{' '}
            <span className="text-muted-foreground">Nothing needs you.</span>
          </p>
        </div>
      ) : (
        <ul aria-label="Needs attention" className="flex flex-col">
          {shown.map((item) => (
            <li
              key={item.key}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 border-t border-white/6 py-3"
            >
              <StatusGlyph tone={item.tone} />
              <div className="min-w-0">
                <p className="line-clamp-2 text-sm font-semibold">
                  {item.title}
                </p>
                <p className="mt-0.5 truncate text-xs text-subtle-foreground">
                  {item.detail}
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
      )}
      {items.length > NEEDS_ATTENTION_LIMIT || moreFailedRuns ? (
        <p className="border-t border-white/6 pt-2 text-xs text-subtle-foreground">
          {items.length > NEEDS_ATTENTION_LIMIT
            ? `${String(items.length - NEEDS_ATTENTION_LIMIT)} more not shown. `
            : ''}
          {moreFailedRuns
            ? 'Counting the latest 100 problem runs of each kind.'
            : ''}
        </p>
      ) : null}
    </HomeBlock>
  );
}
