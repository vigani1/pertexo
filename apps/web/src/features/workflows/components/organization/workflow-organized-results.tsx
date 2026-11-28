import { StatusMark } from '@/components/patterns/status/status-mark';
import { countWorkflowStates } from '../../model/list-view';
import { StatusGuide } from '@/components/patterns/guidance/status-guide';
import { WORKFLOW_LIST_GUIDE } from '../../model/guide';
import {
  COLLAPSED_LIST_COUNT,
  ShowAll,
} from '@/components/patterns/lists/show-all';
import { PROMOTION_LIMITS } from '@pertexo/workflow-model';
import { Link } from '@tanstack/react-router';
import { promotionSearch } from '@/features/workflow-promotions/public';
import { XIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type {
  AccessibleWorkspace,
  WorkflowOrganizationProjectionResponse,
  WorkflowListResponse,
} from '@pertexo/contracts';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyTitle,
  EmptyDescription,
} from '@/components/patterns/states/empty';
import { StaleLine } from '@/components/patterns/states/stale-line';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/class-names';
import {
  ROW_REVEAL_CLASS,
  type WorkflowRowActions,
} from '../list/workflow-row-actions';
import { WorkflowRows, WorkflowListFooter } from '../list/workflow-rows';
import { canEditOrganization } from '../../model/organization/selection-editing';
import { WorkflowOrganizationDialog } from './dialog';
import { WorkflowOrganizationRowMenu } from './row-menu';

/** Selection is explicit, ordered and bounded to loaded rows in one URL scope. */
type WorkflowOrganizedResultsProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  items: readonly WorkflowOrganizationProjectionResponse[];
  workflows: Pick<
    UseInfiniteQueryResult<InfiniteData<WorkflowListResponse>>,
    | 'isRefetchError'
    | 'dataUpdatedAt'
    | 'isFetching'
    | 'refetch'
    | 'hasNextPage'
    | 'isFetchingNextPage'
    | 'isFetchNextPageError'
    | 'fetchNextPage'
  >;
  actions: WorkflowRowActions;
  filtering: boolean;
}>;

export function WorkflowOrganizedResults({
  apiClient,
  userId,
  workspace,
  items,
  workflows,
  actions,
  filtering,
}: WorkflowOrganizedResultsProps) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const preview = !expanded && !filtering;
  const visible = preview ? items.slice(0, COLLAPSED_LIST_COUNT) : items;
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [editing, setEditing] =
    useState<readonly WorkflowOrganizationProjectionResponse[]>();
  const currentSelected = selected.flatMap((id) => {
    const item = items.find((entry) => entry.workflow.id === id);
    return item === undefined ? [] : [item];
  });
  const canEdit = canEditOrganization(workspace, [], 'move');
  const byId = new Map(items.map((item) => [item.workflow.id, item]));
  function selectionControl(id: string): ReactNode {
    const item = byId.get(id);
    if (item === undefined) return null;
    const allowed = canEditOrganization(workspace, [item], 'move');
    if (!allowed) return null;
    return (
      <Checkbox
        aria-label={`Select ${item.workflow.name}`}
        className={cn(
          // A bead: a hollow loop that ties into a knot when picked, with a
          // 32px (44px on touch) hit area around it.
          'relative size-4 rounded-full [&_svg]:size-2.5 after:absolute after:-inset-2 pointer-coarse:after:-inset-3.5',
          currentSelected.length === 0 && ROW_REVEAL_CLASS,
        )}
        checked={selected.includes(id)}
        disabled={
          editing !== undefined ||
          (!selected.includes(id) && selected.length >= 50)
        }
        onCheckedChange={(checked) => {
          setSelected((previous) =>
            checked
              ? [...previous.filter((entry) => entry !== id), id]
              : previous.filter((entry) => entry !== id),
          );
        }}
      />
    );
  }
  return (
    <section aria-label="Workspace workflows" className="flex flex-col gap-4">
      {/* Floats above the list instead of pushing it down, so picking the
          first workflow never moves the row under the pointer. */}
      {canEdit && currentSelected.length > 0 ? (
        <SelectedWorkflowTools
          workspace={workspace}
          selected={currentSelected}
          disabled={editing !== undefined}
          onOrganize={() => {
            setEditing(currentSelected);
          }}
          onClear={() => {
            setSelected([]);
          }}
        />
      ) : null}
      {workflows.isRefetchError ? (
        <StaleLine
          updatedAt={workflows.dataUpdatedAt}
          retrying={workflows.isFetching}
          onRetry={() => void workflows.refetch()}
        />
      ) : null}
      {items.length === 0 ? (
        <Empty>
          <EmptyTitle>No workflows match these filters</EmptyTitle>
          <EmptyDescription>
            Change the filters above, or create a workflow. Folder filters
            include this folder only, not its descendants.
          </EmptyDescription>
        </Empty>
      ) : (
        <div id={listId}>
          <WorkflowRows
            workspace={workspace}
            workflows={visible.map((item) => item.workflow)}
            actions={actions}
            {...(canEdit ? { rowSelection: selectionControl } : {})}
            rowTags={(id) => workflowTags(byId.get(id))}
            rowMenu={(id, runnable) => {
              const item = byId.get(id);
              if (item === undefined) return null;
              const allowed = canEditOrganization(workspace, [item], 'move');
              return (
                <WorkflowOrganizationRowMenu
                  apiClient={apiClient}
                  userId={userId}
                  workspace={workspace}
                  workflow={item}
                  actions={actions}
                  runnable={runnable}
                  disabled={editing !== undefined}
                  {...(allowed
                    ? {
                        onOrganize: () => {
                          setEditing([item]);
                        },
                      }
                    : {})}
                />
              );
            }}
          />
        </div>
      )}
      {filtering ? null : (
        <WorkflowPreview
          count={items.length}
          id={listId}
          expanded={expanded}
          change={setExpanded}
          partial={workflows.hasNextPage}
        />
      )}
      <WorkflowListFooter
        hasNextPage={workflows.hasNextPage}
        loadingNextPage={workflows.isFetchingNextPage}
        nextPageError={workflows.isFetchNextPageError}
        filtering={filtering}
        loadedCount={items.length}
        onLoadMore={() => void workflows.fetchNextPage()}
      />
      <WorkflowResultsGuide items={items} partial={workflows.hasNextPage} />
      {editing === undefined ? null : (
        <WorkflowOrganizationDialog
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflows={editing}
          onClose={() => {
            setEditing(undefined);
            setSelected([]);
          }}
        />
      )}
    </section>
  );
}

function workflowTags(
  item: WorkflowOrganizedResultsProps['items'][number] | undefined,
) {
  if (item === undefined || item.organization.tags.length === 0) return null;
  return (
    <span className="text-xs text-muted-foreground">
      {item.organization.tags.map((tag) => tag.key).join(' · ')}
    </span>
  );
}
function WorkflowPreview({
  count,
  id,
  expanded,
  change,
  partial,
}: Readonly<{
  count: number;
  id: string;
  expanded: boolean;
  change: (expanded: boolean) => void;
  partial: boolean;
}>) {
  if (!partial)
    return (
      <ShowAll
        count={count}
        controls={id}
        expanded={expanded}
        onExpandedChange={change}
      />
    );
  if (expanded || count <= COLLAPSED_LIST_COUNT) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-controls={id}
      aria-expanded={false}
      onClick={() => {
        change(true);
      }}
    >
      Show more loaded workflows
    </Button>
  );
}

function WorkflowResultsGuide({
  items,
  partial,
}: Readonly<{
  items: WorkflowOrganizedResultsProps['items'];
  partial: boolean;
}>) {
  if (items.length === 0) return null;
  const counts = partial
    ? []
    : countWorkflowStates(items.map(({ workflow }) => workflow));
  return (
    <div className="flex flex-wrap items-center gap-3">
      {counts.map((state) => (
        <StatusMark key={state.label} tone={state.tone} typography="metadata">
          {state.count} {state.label}
        </StatusMark>
      ))}
      <StatusGuide sections={WORKFLOW_LIST_GUIDE} />
    </div>
  );
}

function SelectedWorkflowTools({
  workspace,
  selected,
  disabled,
  onOrganize,
  onClear,
}: Readonly<{
  workspace: AccessibleWorkspace;
  selected: readonly WorkflowOrganizationProjectionResponse[];
  disabled: boolean;
  onOrganize: () => void;
  onClear: () => void;
}>) {
  return (
    <div
      role="toolbar"
      aria-label="Selected workflows"
      className="lens fixed bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.75rem)] left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl py-1.5 pr-1.5 pl-3.5 motion-safe:animate-[rise_0.25s_var(--ease-unspool)] md:bottom-6"
    >
      <span
        aria-hidden="true"
        className="mr-1 size-2.5 shrink-0 rounded-full bg-action ring-2 ring-action-soft"
      />
      <span
        className="mr-2 text-sm whitespace-nowrap text-foreground"
        aria-live="polite"
      >
        {String(selected.length)} selected
        {selected.length >= 50 ? (
          <span className="text-muted-foreground"> · the most at once</span>
        ) : null}
      </span>
      <Button
        variant="default"
        size="sm"
        aria-label="Organize selected…"
        disabled={disabled}
        onClick={() => {
          onOrganize();
        }}
      >
        Organize…
      </Button>
      {workspace.capabilities.includes('workflow:update') &&
      selected.length <= PROMOTION_LIMITS.workflows &&
      selected.every((item) => item.workflow.publishedVersionId !== null) ? (
        <Button
          variant="outline"
          size="sm"
          render={
            <Link
              to="/w/$workspaceId/settings/promotion"
              params={{ workspaceId: workspace.id }}
              search={promotionSearch(
                selected.flatMap((item) =>
                  item.workflow.publishedVersionId === null
                    ? []
                    : [
                        {
                          workflowId: item.workflow.id,
                          versionId: item.workflow.publishedVersionId,
                        },
                      ],
                ),
              )}
            />
          }
        >
          Promote…
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear selection"
        title="Clear selection"
        disabled={disabled}
        onClick={() => {
          onClear();
        }}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
}
