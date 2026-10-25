import { CheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { StatusGlyph } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import type { IssuesState } from '../../model/validation/issues-state';
import type { EmptyDraftHint } from '../../model/publication/readiness';
import { countIssues } from '../../model/validation/issues';

/** The issues lens the chip opens; the editor places it at the bottom. */
export const ISSUES_LENS_ID = 'editor-issues-lens';
/** The chip itself, where focus returns when the lens closes. */
export const ISSUES_CHIP_ID = 'editor-issues-chip';

/**
 * The command bar's issue count. Opens and closes the bottom issues lens.
 * An empty draft says what to add first instead of claiming “No issues”,
 * unless the server found some. Phones keep a readable label beside the
 * glyph and count; longer check messages truncate and retain a tooltip.
 */
export function IssuesChip({
  state,
  emptyHint,
  open,
  onOpenChange,
}: Readonly<{
  state: IssuesState;
  emptyHint: EmptyDraftHint | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const count =
    state.groups === undefined ? undefined : countIssues(state.groups);
  const hasIssues = count !== undefined && count > 0;
  const hint = hasIssues ? undefined : emptyHint;
  const successClass =
    count === 0 &&
    !state.stale &&
    hint === undefined &&
    'text-success hover:text-success';
  return (
    <button
      id={ISSUES_CHIP_ID}
      type="button"
      aria-label={hint?.label}
      title={hint?.detail ?? describeChip(state, count)}
      aria-expanded={open}
      aria-controls={open ? ISSUES_LENS_ID : undefined}
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'sm' }),
        'w-20 min-w-0 shrink-0 gap-1 px-1.5 sm:w-32 sm:gap-2 sm:px-2.5',
        successClass,
        hasIssues && 'text-destructive hover:text-destructive',
        state.stale && 'opacity-70',
      )}
      onClick={() => {
        onOpenChange(!open);
      }}
    >
      {hint === undefined ? (
        <ChipLabel state={state} count={count} />
      ) : (
        <>
          <StatusGlyph tone="neutral" />
          <Words>
            {hint.label === 'Add a trigger to start'
              ? 'Add trigger'
              : 'Add step'}
          </Words>
        </>
      )}
    </button>
  );
}

/** Long setup or check messages retain their complete accessible name. */
function Words({
  children,
  wrap = false,
}: Readonly<{ children: ReactNode; wrap?: boolean }>) {
  return (
    <span
      className={cn(
        'min-w-0 text-xs leading-tight',
        wrap ? 'whitespace-normal' : 'truncate',
      )}
    >
      {children}
    </span>
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
        <Words>{describeChip(state, count)}</Words>
      </>
    );
  if (count === undefined)
    return state.error === undefined ? (
      <>
        <StatusGlyph tone="neutral" className="sm:hidden" />
        <Words>{describeChip(state, count)}</Words>
      </>
    ) : (
      <>
        <StatusGlyph tone="attention" className="text-warning" />
        <Words>{describeChip(state, count)}</Words>
      </>
    );
  if (count === 0)
    return (
      <>
        <CheckIcon data-icon="inline-start" />
        <Words wrap>{describeChip(state, count)}</Words>
      </>
    );
  return (
    <>
      <StatusGlyph tone="failure" />
      {count} <Words>{count === 1 ? 'issue' : 'issues'}</Words>
    </>
  );
}

function describeChip(state: IssuesState, count: number | undefined): string {
  if (count !== undefined)
    return count === 0
      ? 'No issues'
      : `${String(count)} ${count === 1 ? 'issue' : 'issues'}`;
  if (state.checking) return 'Checking…';
  return state.error === undefined ? 'Not checked yet' : 'Couldn’t check';
}
