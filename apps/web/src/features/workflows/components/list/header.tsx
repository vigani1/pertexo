import type { ReactNode } from 'react';
import type { WorkflowSummary } from '@pertexo/contracts';
import { PlusIcon } from 'lucide-react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { StatusGuide } from '@/components/patterns/guidance/status-guide';
import { WORKFLOW_LIST_GUIDE } from '../../model/guide';
import { countWorkflowStates } from '../../model/list-view';

/**
 * The list's one primary action. Its N shortcut shows on hover, not as an
 * unexplained letter inside the button.
 */
export function NewWorkflowButton({
  onClick,
}: Readonly<{ onClick: () => void }>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="primary"
            aria-keyshortcuts="N"
            onClick={onClick}
          />
        }
      >
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        New workflow
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        Shortcut <Kbd>N</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Title, a mono line counting loaded workflows by state ("+" while more pages
 * exist, since counts cover only what's loaded) and the page's `actions`,
 * e.g. `<NewWorkflowButton />`.
 */
export function WorkflowListHeader({
  workflows,
  loading,
  hasMore,
  actions,
}: Readonly<{
  workflows: readonly WorkflowSummary[];
  loading: boolean;
  hasMore: boolean;
  actions?: ReactNode;
}>) {
  const more = hasMore ? '+' : '';
  const total = workflows.length;
  return (
    <PageHeader>
      <div className="min-w-0">
        <PageHeaderTitle>Workflows</PageHeaderTitle>
        {!loading && total === 0 && !hasMore ? null : (
          <PageHeaderMeta>
            {loading ? (
              <Skeleton className="h-3 w-56" />
            ) : (
              <>
                <span>
                  <b className="font-semibold text-foreground">
                    {total.toLocaleString()}
                    {more}
                  </b>{' '}
                  {total === 1 && more === '' ? 'workflow' : 'workflows'}
                </span>
                {countWorkflowStates(workflows).map((state) => (
                  <Status
                    key={state.label}
                    tone={state.tone}
                    className="font-mono text-xs font-normal"
                  >
                    <b className="font-semibold">
                      {state.count.toLocaleString()}
                      {more}
                    </b>{' '}
                    {state.label}
                  </Status>
                ))}
                <StatusGuide
                  sections={WORKFLOW_LIST_GUIDE}
                  className="-my-1 -ml-2"
                />
              </>
            )}
          </PageHeaderMeta>
        )}
      </div>
      {actions === undefined ? null : (
        <PageHeaderActions>{actions}</PageHeaderActions>
      )}
    </PageHeader>
  );
}
