import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
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
import { countWorkflowStates } from '../model/workflow-list-view';

/**
 * Title, a mono line counting loaded workflows by state ("+" while more pages
 * exist, since counts cover only what's loaded) and the one primary action.
 */
export function WorkflowListHeader({
  workflows,
  loading,
  hasMore,
  showCreate,
  onCreate,
}: Readonly<{
  workflows: readonly WorkflowSummary[];
  loading: boolean;
  hasMore: boolean;
  showCreate: boolean;
  onCreate: () => void;
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
                    {String(total)}
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
                      {String(state.count)}
                      {more}
                    </b>{' '}
                    {state.label}
                  </Status>
                ))}
              </>
            )}
          </PageHeaderMeta>
        )}
      </div>
      {showCreate ? (
        <PageHeaderActions>
          <Button type="button" variant="primary" onClick={onCreate}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            New workflow
            <Kbd aria-hidden="true" className="hidden sm:inline-flex">
              N
            </Kbd>
          </Button>
        </PageHeaderActions>
      ) : null}
    </PageHeader>
  );
}
