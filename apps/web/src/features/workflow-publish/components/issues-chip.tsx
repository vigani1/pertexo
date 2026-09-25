import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { CheckIcon, RefreshCwIcon } from 'lucide-react';
import { useRef } from 'react';
import { ProgressButton } from '@/components/ui/progress-button';
import { buttonVariants } from '@/components/ui/button-variants';
import { LoadingOrb } from '@/components/ui/loading-orb';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { StatusGlyph } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import type { IssuesState } from '../model/issues-state';
import type { EmptyDraftHint } from '../model/publish-readiness';
import { countIssues } from '../model/workflow-issues';
import type { WorkflowValidationTarget } from '../model/validation-target';
import { IssuesList } from './issues-list';

/**
 * The command bar's issue count. Opens the issues lens: findings grouped by
 * step, each with Fix, and a way to check again. An empty draft says what to
 * add first instead of claiming “No issues”, unless the server found some.
 */
export function IssuesChip({
  state,
  graph,
  emptyHint,
  open,
  onOpenChange,
  onCheckAgain,
  onFix,
}: Readonly<{
  state: IssuesState;
  graph: WorkflowGraphContract;
  emptyHint: EmptyDraftHint | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheckAgain: () => void;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  const count =
    state.groups === undefined ? undefined : countIssues(state.groups);
  const hint = count !== undefined && count > 0 ? undefined : emptyHint;
  // Fix moves focus to the field it names; the popover must not take it back.
  const fixing = useRef(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) fixing.current = false;
        onOpenChange(next);
      }}
    >
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          count === 0 &&
            !state.stale &&
            hint === undefined &&
            'text-success hover:text-success',
          count !== undefined &&
            count > 0 &&
            'text-destructive hover:text-destructive',
          state.stale && 'opacity-70',
        )}
      >
        {hint === undefined ? (
          <ChipLabel state={state} count={count} />
        ) : (
          <>
            <StatusGlyph tone="neutral" />
            {hint.label}
          </>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(24rem,calc(100vw-2rem))]"
        finalFocus={() => !fixing.current}
      >
        <PopoverTitle>
          {count === undefined || count === 0
            ? 'Issues'
            : `${String(count)} ${count === 1 ? 'issue' : 'issues'}`}
        </PopoverTitle>
        <PopoverDescription>
          {hint === undefined ? describeState(state, count) : hint.detail}
        </PopoverDescription>
        {state.groups !== undefined && state.groups.length > 0 ? (
          <div className="mt-3 max-h-[50svh] overflow-y-auto pr-1">
            <IssuesList
              groups={state.groups}
              graph={graph}
              onFix={(target) => {
                fixing.current = true;
                onOpenChange(false);
                onFix(target);
              }}
            />
          </div>
        ) : null}
        {hint === undefined ? (
          <div className="mt-4 flex justify-end">
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
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ChipLabel({
  state,
  count,
}: Readonly<{ state: IssuesState; count: number | undefined }>) {
  if (state.checking && count === undefined)
    return (
      <>
        <LoadingOrb />
        Checking…
      </>
    );
  if (count === undefined)
    return state.error === undefined ? (
      'Not checked yet'
    ) : (
      <>
        <StatusGlyph tone="attention" className="text-warning" />
        Couldn’t check
      </>
    );
  if (count === 0)
    return (
      <>
        <CheckIcon data-icon="inline-start" />
        No issues
      </>
    );
  return (
    <>
      <StatusGlyph tone="failure" />
      {count} {count === 1 ? 'issue' : 'issues'}
    </>
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
