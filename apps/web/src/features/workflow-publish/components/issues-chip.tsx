import { CheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { StatusGlyph } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import type { IssuesState } from '../model/issues-state';
import type { EmptyDraftHint } from '../model/publish-readiness';
import { countIssues } from '../model/workflow-issues';

/** The issues lens the chip opens; the editor places it at the bottom. */
export const ISSUES_LENS_ID = 'editor-issues-lens';
/** The chip itself, where focus returns when the lens closes. */
export const ISSUES_CHIP_ID = 'editor-issues-chip';

/**
 * The command bar's issue count. Opens and closes the bottom issues lens.
 * An empty draft says what to add first instead of claiming “No issues”,
 * unless the server found some. On phones only the glyph and count show,
 * so Run and Publish keep their room; the words stay for screen readers.
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
  const hint = count !== undefined && count > 0 ? undefined : emptyHint;
  return (
    <button
      id={ISSUES_CHIP_ID}
      type="button"
      aria-expanded={open}
      aria-controls={open ? ISSUES_LENS_ID : undefined}
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
      onClick={() => {
        onOpenChange(!open);
      }}
    >
      {hint === undefined ? (
        <ChipLabel state={state} count={count} />
      ) : (
        <>
          <StatusGlyph tone="neutral" />
          <Words>{hint.label}</Words>
        </>
      )}
    </button>
  );
}

/** Words that fold away on phones, where the chip keeps only its glyph. */
function Words({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="max-sm:sr-only">{children}</span>;
}

function ChipLabel({
  state,
  count,
}: Readonly<{ state: IssuesState; count: number | undefined }>) {
  if (state.checking && count === undefined)
    return (
      <>
        <LoadingOrb />
        <Words>Checking…</Words>
      </>
    );
  if (count === undefined)
    return state.error === undefined ? (
      <>
        <StatusGlyph tone="neutral" className="sm:hidden" />
        <Words>Not checked yet</Words>
      </>
    ) : (
      <>
        <StatusGlyph tone="attention" className="text-warning" />
        <Words>Couldn’t check</Words>
      </>
    );
  if (count === 0)
    return (
      <>
        <CheckIcon data-icon="inline-start" />
        <Words>No issues</Words>
      </>
    );
  return (
    <>
      <StatusGlyph tone="failure" />
      {count} <Words>{count === 1 ? 'issue' : 'issues'}</Words>
    </>
  );
}
