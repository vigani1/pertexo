import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type {
  WorkflowGraphContract,
  WorkflowSummary,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  CalendarClockIcon,
  MousePointerClickIcon,
  PlayIcon,
  WebhookIcon,
  type LucideIcon,
} from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { ProgressButton } from '@/components/ui/progress-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { canRunWorkflow, describeWorkflowState } from '../model/workflow-state';
import {
  describeWorkflowPath,
  workflowTriggerKinds,
  type TriggerKind,
} from '../model/workflow-shape';
import type { RecentRunTicks } from '../use-recent-run-ticks';
import { useSeenOnce } from '../use-seen-once';
import { workflowShapeQueryOptions } from '../workflows.queries';
import { PatternGlyph, PatternGlyphPlaceholder } from './pattern-glyph';
import { RunStrip, RunStripPlaceholder } from './run-strip';
import {
  ROW_REVEAL_CLASS,
  type WorkflowRowActions,
} from './workflow-row-actions';
import { WorkflowRowMenu } from './workflow-row-menu';

/** Shared by the column header and rows so both stay aligned. */
export const WORKFLOW_ROW_COLUMNS =
  'grid-cols-[3.9rem_minmax(0,1fr)_auto] lg:grid-cols-[3.9rem_minmax(0,1fr)_8.5rem_4.5rem_8.75rem_5.5rem_6rem]';

const TRIGGERS: Readonly<
  Record<TriggerKind, Readonly<{ label: string; Icon: LucideIcon }>>
> = {
  webhook: { label: 'Webhook', Icon: WebhookIcon },
  schedule: { label: 'Schedule', Icon: CalendarClockIcon },
  manual: { label: 'Manual', Icon: MousePointerClickIcon },
};

function TriggerIcons({
  graph,
}: Readonly<{ graph: WorkflowGraphContract | undefined }>) {
  if (graph === undefined) return null;
  const kinds = workflowTriggerKinds(graph);
  if (kinds.length === 0)
    return (
      <span className="text-subtle-foreground">
        —<span className="sr-only">No trigger</span>
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      {kinds.map((kind) => {
        const { label, Icon } = TRIGGERS[kind];
        return (
          <span key={kind} title={label}>
            <Icon aria-hidden="true" className="size-3.5" />
          </span>
        );
      })}
      <span className="sr-only">
        Triggers: {kinds.map((kind) => TRIGGERS[kind].label).join(', ')}
      </span>
    </span>
  );
}

function RowGlyph({
  graph,
  state,
  muted,
}: Readonly<{
  graph: WorkflowGraphContract | undefined;
  state: 'loading' | 'unavailable' | 'ready';
  muted: boolean;
}>) {
  if (graph !== undefined) return <PatternGlyph graph={graph} muted={muted} />;
  return (
    <PatternGlyphPlaceholder
      state={state === 'unavailable' ? 'unavailable' : 'loading'}
    />
  );
}

/**
 * Run: starts the published version and opens the new run. It appears on
 * hover and focus like the ⋯ menu, and `R` on the focused row does the same.
 */
function RowRunButton({
  workflow,
  pending,
  disabled,
  onRun,
}: Readonly<{
  workflow: WorkflowSummary;
  pending: boolean;
  disabled: boolean;
  onRun: (workflow: WorkflowSummary) => void;
}>) {
  return (
    <ProgressButton
      type="button"
      size="sm"
      variant="default"
      aria-label={`Run ${workflow.name}`}
      aria-keyshortcuts="R"
      pending={pending}
      pendingLabel="Starting…"
      disabled={disabled}
      icon={<PlayIcon aria-hidden="true" data-icon="inline-start" />}
      // Phones keep the row to its name and facts; Run is in the ⋯ menu.
      className={cn('hidden lg:inline-flex', !pending && ROW_REVEAL_CLASS)}
      onClick={() => {
        onRun(workflow);
      }}
    >
      Run
    </ProgressButton>
  );
}

/** `R` on a focused row runs it, unless someone is typing or in a menu. */
function runShortcut(
  event: KeyboardEvent<HTMLElement>,
  run: (() => void) | undefined,
) {
  if (
    run === undefined ||
    event.key.toLowerCase() !== 'r' ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey ||
    (event.target instanceof HTMLElement &&
      event.target.closest('input, textarea, [role="menu"]') !== null)
  )
    return;
  event.preventDefault();
  run();
}

export function WorkflowRow({
  apiClient,
  userId,
  workspace,
  workflow,
  runs,
  actions,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  runs: RecentRunTicks;
  actions: WorkflowRowActions;
}>) {
  const [observe, seen] = useSeenOnce<HTMLLIElement>();
  const shape = useQuery({
    ...workflowShapeQueryOptions(apiClient, userId, workspace.id, workflow.id),
    enabled: seen,
  });
  const graph = shape.data;
  const state = describeWorkflowState(workflow);
  const runnable = canRunWorkflow(workspace, workflow);
  const run =
    runnable && actions.runningId === undefined
      ? () => {
          actions.onRun(workflow);
        }
      : undefined;

  // One set of cells: on phones the facts wrap under the name; from `lg`
  // their wrapper dissolves (`contents`) so each fact takes its own column.
  return (
    <li
      ref={observe}
      onKeyDown={(event) => {
        runShortcut(event, run);
      }}
      className={`group/row relative grid ${WORKFLOW_ROW_COLUMNS} items-center gap-x-4 gap-y-1.5 rounded-lg border-t border-border px-3 py-3 transition-colors duration-150 first:border-t-0 focus-within:bg-white/[0.03] hover:border-transparent hover:bg-white/[0.035] hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/6%)] motion-reduce:transition-none`}
    >
      <div className="row-span-2 lg:row-span-1">
        <RowGlyph
          graph={graph}
          state={
            shape.isError
              ? 'unavailable'
              : graph === undefined
                ? 'loading'
                : 'ready'
          }
          muted={workflow.publishedVersionId === null}
        />
      </div>
      <div className="min-w-0">
        <Link
          to="/w/$workspaceId/workflows/$workflowId"
          params={{ workspaceId: workspace.id, workflowId: workflow.id }}
          className="block truncate text-[0.95rem] font-semibold text-foreground outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
        >
          {workflow.name}
        </Link>
        {graph === undefined ? (
          shape.isError ? null : (
            <Skeleton className="mt-1.5 h-2.5 w-40 max-w-full" />
          )
        ) : (
          <p className="mt-0.5 truncate text-xs text-subtle-foreground">
            {describeWorkflowPath(graph)}
          </p>
        )}
      </div>
      <div className="col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 lg:contents">
        <div className="min-w-0">
          <Status tone={state.tone} className="text-[0.78rem]">
            {state.label}
          </Status>
        </div>
        <div>
          <TriggerIcons graph={graph} />
        </div>
        <div className="hidden lg:block">
          {!runs.enabled ? null : runs.pending ? (
            <RunStripPlaceholder />
          ) : (
            <RunStrip ticks={runs.ticksFor(workflow.id)} />
          )}
        </div>
        <div>
          <time
            dateTime={workflow.updatedAt}
            title={`Updated ${formatDateTime(workflow.updatedAt)}`}
            className="font-mono text-[0.72rem] text-subtle-foreground"
          >
            {formatRelativeTime(workflow.updatedAt)}
          </time>
        </div>
      </div>
      <div className="relative z-10 col-start-3 row-start-1 flex items-center justify-end gap-1 lg:col-start-7">
        {runnable ? (
          <RowRunButton
            workflow={workflow}
            pending={actions.runningId === workflow.id}
            disabled={actions.runningId !== undefined}
            onRun={actions.onRun}
          />
        ) : null}
        <WorkflowRowMenu
          workspace={workspace}
          workflow={workflow}
          actions={actions}
          runnable={run !== undefined}
        />
      </div>
    </li>
  );
}
