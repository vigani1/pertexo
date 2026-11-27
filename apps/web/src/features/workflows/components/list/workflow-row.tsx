import { useStepDescriptions } from '@/features/catalog/public';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import {
  CalendarClockIcon,
  DatabaseIcon,
  ClipboardListIcon,
  TriangleAlertIcon,
  MousePointerClickIcon,
  PlayIcon,
  WebhookIcon,
  type LucideIcon,
} from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ProgressButton } from '@/components/ui/progress-button';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { cn } from '@/lib/class-names';
import { CLOCK_TICK, useNow } from '@/lib/hooks/use-now';
import {
  canRunWorkflow,
  describeWorkflowState,
} from '../../model/workflow-state';
import {
  describeWorkflowPath,
  workflowTriggerKinds,
  type TriggerKind,
} from '../../model/shape';
import { failureStrip } from '../../model/run-strip';
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
  'grid-cols-[calc(3.9rem_+_var(--row-select,0rem))_minmax(0,1fr)_auto] lg:grid-cols-[calc(3.9rem_+_var(--row-select,0rem))_minmax(0,1fr)_4.5rem_7rem_5.5rem_6rem]';

const TRIGGERS: Readonly<
  Record<TriggerKind, Readonly<{ label: string; Icon: LucideIcon }>>
> = {
  'core.webhook': { label: 'Webhook', Icon: WebhookIcon },
  'database.poll': { label: 'Database Row', Icon: DatabaseIcon },
  'http.poll': { label: 'HTTP Polling', Icon: CalendarClockIcon },
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

/** The name, opening the workflow, and its state on one quiet line. */
function RowTitle({
  workspaceId,
  workflow,
  graph,
  state,
}: Readonly<{
  workspaceId: string;
  workflow: WorkflowSummary;
  graph: WorkflowShape | undefined;
  state: ReturnType<typeof describeWorkflowState>;
}>) {
  const describeStep = useStepDescriptions();
  return (
    <div className="min-w-0">
      <Link
        to="/w/$workspaceId/workflows/$workflowId"
        params={{ workspaceId, workflowId: workflow.id }}
        className="block truncate text-lead font-semibold text-foreground outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
      >
        {workflow.name}
      </Link>
      {/* The shape glyph draws the path; its words are for screen readers. */}
      {graph === undefined ? null : (
        <span className="sr-only">
          {describeWorkflowPath(graph, undefined, describeStep)}
        </span>
      )}
      <StatusMark tone={state.tone} className="mt-1">
        {state.label}
      </StatusMark>
    </div>
  );
}

/** The workflow's failures this week as a strip, or why there isn't one. */
function RowRuns({
  summary,
}: Readonly<{ summary: WorkflowSummary['listSummary'] }>) {
  // The week slides with the clock, so a list left open stays honest.
  const nowMs = useNow({ intervalMs: CLOCK_TICK.chart });
  if (summary?.recentRuns === undefined)
    return (
      <span className="font-mono text-caption text-subtle-foreground">
        Couldn’t load
      </span>
    );
  return <RunStrip strip={failureStrip(summary.recentRuns, nowMs)} />;
}

function UpdatedAt({ at }: Readonly<{ at: string }>) {
  return (
    <time
      dateTime={at}
      title={`Updated ${formatDateTime(at)}`}
      className="font-mono text-caption text-subtle-foreground"
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

  // One line per workflow: on phones and tablets the name and its state;
  // from `lg` the facts' wrapper dissolves (`contents`) into their columns.
  return (
    <li
      onKeyDown={(event) => {
        runShortcut(event, run);
      }}
      className={cn(
        'group/row row-divider grid items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 focus-within:bg-select hover:bg-select',
        WORKFLOW_ROW_COLUMNS,
      )}
    >
      <div className="flex items-center gap-2">
        {selectionControl == null ? null : (
          <span className="relative z-10 flex size-4 shrink-0">
            {selectionControl}
          </span>
        )}
        <RowGlyph graph={graph} muted={workflow.publishedVersionId === null} />
      </div>
      <RowTitle
        workspaceId={workspace.id}
        workflow={workflow}
        graph={graph}
        state={state}
      />
      <div className="hidden lg:contents">
        <div>
          <TriggerIcons graph={graph} />
        </div>
        <div>
          {showRuns ? <RowRuns summary={workflow.listSummary} /> : null}
        </div>
        <div>
          <UpdatedAt at={workflow.updatedAt} />
        </div>
      </div>
      <div className="relative z-10 col-start-3 row-start-1 flex items-center justify-end gap-1 lg:col-start-6">
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
        <div className="col-start-2 row-start-2 min-w-0">{tags}</div>
      )}
    </li>
  );
}
