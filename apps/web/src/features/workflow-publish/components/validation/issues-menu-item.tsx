import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { StatusMark } from '@/components/patterns/status/status-mark';
import type { IssuesState } from '../../model/validation/issues-state';
import type { EmptyDraftHint } from '../../model/publication/readiness';
import { countIssues } from '../../model/validation/issues';
import { formatCount } from '@/lib/format/count';

export function IssuesMenuItem({
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
  const count = state.groups === undefined ? 0 : countIssues(state.groups);
  const label = issuesLabel(state, count, emptyHint);
  return (
    <DropdownMenuItem
      onClick={() => {
        onOpenChange(!open);
      }}
    >
      <StatusMark display="mark" tone={count > 0 ? 'failure' : 'neutral'} />
      {label}
    </DropdownMenuItem>
  );
}

function issuesLabel(
  state: IssuesState,
  count: number,
  emptyHint: EmptyDraftHint | undefined,
): string {
  if (count > 0) return formatCount(count, 'issue');
  if (emptyHint !== undefined) return emptyHint.label;
  if (state.groups !== undefined) return 'No issues';
  if (state.checking) return 'Checking…';
  return state.error === undefined ? 'Not checked yet' : 'Couldn’t check';
}
