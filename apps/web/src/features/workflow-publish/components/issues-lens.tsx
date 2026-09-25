import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { RefreshCwIcon, XIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { StatusGlyph } from '@/components/ui/status';
import type { IssuesState } from '../model/issues-state';
import { emptyDraftHint } from '../model/publish-readiness';
import type { WorkflowValidationTarget } from '../model/validation-target';
import { countIssues } from '../model/workflow-issues';
import { ISSUES_CHIP_ID, ISSUES_LENS_ID } from './issues-chip';
import { IssuesList } from './issues-list';

/**
 * The issues lens at the bottom of the editor, opened from the command
 * bar's chip: findings grouped by step in human words, each with Fix, and
 * a way to check again. It floats over the canvas instead of pushing it
 * down. Fix closes it and jumps to the field; ✕ and Escape return to the
 * chip.
 */
export function IssuesLens({
  open,
  state,
  graph,
  triggersAvailable,
  onOpenChange,
  onCheckAgain,
  onFix,
}: Readonly<{
  open: boolean;
  state: IssuesState;
  graph: WorkflowGraphContract;
  /** The catalog offers a trigger to start an empty draft with. */
  triggersAvailable: boolean;
  onOpenChange: (open: boolean) => void;
  onCheckAgain: () => void;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  const titleId = useId();
  if (!open) return null;
  const count =
    state.groups === undefined ? undefined : countIssues(state.groups);
  const hint =
    count !== undefined && count > 0
      ? undefined
      : emptyDraftHint(graph, triggersAvailable);
  function close() {
    onOpenChange(false);
    document.getElementById(ISSUES_CHIP_ID)?.focus();
  }
  return (
    <section
      id={ISSUES_LENS_ID}
      aria-labelledby={titleId}
      className="lens pointer-events-auto flex max-h-[min(24rem,45svh)] flex-col rounded-xl"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        close();
      }}
    >
      <header className="flex items-start gap-3 border-b border-white/7 px-4 py-3">
        <StatusGlyph
          tone={count !== undefined && count > 0 ? 'failure' : 'neutral'}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">
            {count === undefined || count === 0
              ? 'Issues'
              : `${String(count)} ${count === 1 ? 'issue' : 'issues'}`}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hint === undefined ? describeState(state, count) : hint.detail}
          </p>
        </div>
        {hint === undefined ? (
          <ProgressButton
            type="button"
            size="sm"
            variant="outline"
            pending={state.checking}
            pendingLabel="Checking…"
            icon={<RefreshCwIcon data-icon="inline-start" />}
            onClick={onCheckAgain}
          >
            Check again
          </ProgressButton>
        ) : null}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Close issues"
          onClick={close}
        >
          <XIcon />
        </Button>
      </header>
      {state.groups !== undefined && state.groups.length > 0 ? (
        <div className="min-h-0 overflow-y-auto px-4 py-3">
          <IssuesList
            groups={state.groups}
            graph={graph}
            onFix={(target) => {
              onOpenChange(false);
              onFix(target);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

function describeState(state: IssuesState, count: number | undefined) {
  if (state.checking) return 'Checking the saved draft…';
  if (state.error !== undefined) return state.error;
  if (count === undefined)
    return 'Pertexo checks the draft for issues shortly after you stop editing.';
  const staleNote = state.stale
    ? ' These are from before your latest edits.'
    : '';
  if (count === 0) return `Nothing blocks publishing.${staleNote}`;
  return `Fix these before publishing.${staleNote}`;
}
