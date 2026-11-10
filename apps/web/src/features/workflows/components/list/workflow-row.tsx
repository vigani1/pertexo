import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import {
  CalendarClockIcon,
  ClipboardListIcon,
  TriangleAlertIcon,
  MousePointerClickIcon,
  PlayIcon,
  WebhookIcon,
  type LucideIcon,
} from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ProgressButton } from '@/components/ui/progress-button';
import { Status } from '@/components/ui/status';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { cn } from '@/lib/class-names';
import {
  canRunWorkflow,
  describeWorkflowState,
} from '../../model/workflow-state';
import {
  describeWorkflowPath,
  workflowTriggerKinds,
  type TriggerKind,
} from '../../model/shape';
import { runTicks } from '../../model/run-strip';
import type { WorkflowShape } from '../../model/shape';
import { PatternGlyph, PatternGlyphPlaceholder } from '../pattern-glyph';
import { RunStrip } from './run-strip';
import {
  ROW_REVEAL_CLASS,
  type WorkflowRowActions,
} from './workflow-row-actions';
import { WorkflowRowMenu } from './workflow-row-menu';

/**
 * Shared by the column header and rows so both stay aligned. A list that
 * offers selection sets `--row-select` to make room for the bead before the
 * thread, so the bead never sits on anything.
 */
export const WORKFLOW_ROW_COLUMNS =
  'grid-cols-[calc(3.9rem_+_var(--row-select,0rem))_minmax(0,1fr)_auto] lg:grid-cols-[calc(3.9rem_+_var(--row-select,0rem))_minmax(0,1fr)_8.5rem_4.5rem_8.75rem_5.5rem_6rem]';

const TRIGGERS: Readonly<
  Record<TriggerKind, Readonly<{ label: string; Icon: LucideIcon }>>
> = {
  'core.webhook': { label: 'Webhook', Icon: WebhookIcon },
  'core.schedule': { label: 'Schedule', Icon: CalendarClockIcon },
  'core.manual': { label: 'Manual', Icon: MousePointerClickIcon },
  'core.form': { label: 'Form', Icon: ClipboardListIcon },
  'core.workflow_error': {
    label: 'When a workflow fails',
    Icon: TriangleAlertIcon,
  },
};

function TriggerIcons({
  graph,
}: Readonly<{ graph: WorkflowShape | undefined }>) {
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
  muted,
}: Readonly<{
  graph: WorkflowShape | undefined;
  muted: boolean;
}>) {
  if (graph !== undefined) return <PatternGlyph graph={graph} muted={muted} />;
  return <PatternGlyphPlaceholder state="unavailable" />;
}

/** The name, opening the workflow, and its path in words once it's read. */
function RowTitle({
  workspaceId,
  workflow,
  graph,
}: Readonly<{
  workspaceId: string;
  workflow: WorkflowSummary;
  graph: WorkflowShape | undefined;
}>) {
  return (
    <div className="min-w-0">
      <Link
        to="/w/$workspaceId/workflows/$workflowId"
        params={{ workspaceId, workflowId: workflow.id }}
        className="block truncate text-[0.95rem] font-semibold text-foreground outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
      >
        {workflow.name}
      </Link>
      {/* One line tall in every state, so a row never grows when its path
          arrives: first load and every filter change keep the list still. */}
      <div className="mt-0.5 flex h-4 items-center">
        <RowPath graph={graph} />
      </div>
    </div>
  );
}

/** The workflow's own latest runs as a strip, or why there isn't one. */
function RowRuns({
  summary,
}: Readonly<{ summary: WorkflowSummary['listSummary'] }>) {
  if (summary?.recentRuns === undefined)
    return (
      <span className="font-mono text-[0.7rem] text-subtle-foreground">
        Couldn’t load
      </span>
    );
  return <RunStrip ticks={runTicks(summary.recentRuns)} />;
}

function UpdatedAt({ at }: Readonly<{ at: string }>) {
  return (
    <time
      dateTime={at}
      title={`Updated ${formatDateTime(at)}`}
      className="font-mono text-[0.72rem] text-subtle-foreground"
    >
      {formatRelativeTime(at)}
    </time>
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
  const runShortcutBlocked =
    run === undefined ||
    event.key.toLowerCase() !== 'r' ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey ||
    (event.target instanceof HTMLElement &&
      event.target.closest('input, textarea, [role="menu"]') !== null);
  if (runShortcutBlocked) return;
  event.preventDefault();
  run();
}

export function WorkflowRow({
  workspace,
  workflow,
  actions,
  selectionControl,
  tags,
  rowMenu,
}: Readonly<{
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  actions: WorkflowRowActions;
  rowMenu?: (workflowId: string, runnable: boolean) => ReactNode;
  selectionControl?: ReactNode;
  tags?: ReactNode;
}>) {
  const showRuns = workspace.capabilities.includes('run:read');
  const graph = workflow.listSummary?.shape;
  const state = describeWorkflowState(workflow);
  const runnable = canRunWorkflow(workspace, workflow);
  const run =
    runnable && actions.runningId === undefined
      ? () => {
          actions.onRun(workflow);
        }
      : undefined;

  // The divider is a straight inset line, not the top border of a rounded
  // row, so its ends don't curl. A lit row hides the lines on both its
  // edges: its own above it and the next row's below it.
  // One set of cells: on phones the facts wrap under the name; from `lg`
  // their wrapper dissolves (`contents`) so each fact takes its own column.
  return (
    <li
      onKeyDown={(event) => {
        runShortcut(event, run);
      }}
      className={`group/row relative grid ${WORKFLOW_ROW_COLUMNS} items-center gap-x-4 gap-y-1.5 rounded-lg px-3 py-3 transition-colors duration-150 before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-border first:before:hidden focus-within:bg-surface-ink/[0.03] hover:bg-surface-ink/[0.035] hover:before:opacity-0 focus-within:before:opacity-0 [:focus-within+&]:before:opacity-0 [:hover+&]:before:opacity-0 hover:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--surface-ink)_6%,transparent)] motion-reduce:transition-none`}
    >
      <div className="row-span-2 flex items-center gap-2 lg:row-span-1">
        {selectionControl == null ? null : (
          <span className="relative z-10 flex size-4 shrink-0">
            {selectionControl}
          </span>
        )}
        <RowGlyph graph={graph} muted={workflow.publishedVersionId === null} />
      </div>
      <RowTitle workspaceId={workspace.id} workflow={workflow} graph={graph} />
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
          {showRuns ? <RowRuns summary={workflow.listSummary} /> : null}
        </div>
        <div>
          <UpdatedAt at={workflow.updatedAt} />
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
        {rowMenu === undefined ? (
          <WorkflowRowMenu
            workspace={workspace}
            workflow={workflow}
            actions={actions}
            runnable={run !== undefined}
          />
        ) : (
          rowMenu(workflow.id, run !== undefined)
        )}
      </div>
      {tags == null ? null : (
        <div className="col-start-2 row-start-3 min-w-0 lg:row-start-2">
          {tags}
        </div>
      )}
    </li>
  );
}

function RowPath({ graph }: Readonly<{ graph: WorkflowShape | undefined }>) {
  if (graph === undefined) return null;
  return (
    <p className="truncate text-xs/4 text-subtle-foreground">
      {describeWorkflowPath(graph)}
    </p>
  );
}
