import { RotateCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { StatusGlyph } from '@/components/ui/status';
import { readFailureReason } from '@/lib/api/api-error-copy';
import type { WorkflowView } from '../model/workflow-list-view';

export function WorkflowListError({
  error,
  retrying,
  onRetry,
}: Readonly<{ error: unknown; retrying: boolean; onRetry: () => void }>) {
  return (
    <Empty>
      <EmptyMedia>
        <StatusGlyph tone="failure" className="text-destructive" />
      </EmptyMedia>
      <EmptyTitle>Workflows didn’t load</EmptyTitle>
      <EmptyDescription>{readFailureReason(error)}</EmptyDescription>
      <EmptyActions>
        <Button type="button" disabled={retrying} onClick={onRetry}>
          <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
          {retrying ? 'Trying again…' : 'Try again'}
        </Button>
      </EmptyActions>
    </Empty>
  );
}

function filteredCopy(view: WorkflowView, query: string) {
  if (query.trim() !== '')
    return {
      title: `Nothing matches “${query.trim()}”`,
      description:
        view === 'all'
          ? 'Check the spelling, or clear the filter.'
          : 'Check the spelling, clear the filter, or look under All.',
    };
  if (view === 'archived')
    return {
      title: 'No archived workflows',
      description:
        'Archived workflows show up here. Archiving stops new runs and keeps their history.',
    };
  return {
    title: 'No active workflows',
    description:
      'Every workflow here is archived. Look under Archived to restore one.',
  };
}

/** The loaded workflows exist, but none match the filter or view. */
export function WorkflowListNoMatches({
  view,
  query,
  onClear,
}: Readonly<{ view: WorkflowView; query: string; onClear: () => void }>) {
  const copy = filteredCopy(view, query);
  return (
    <Empty>
      <EmptyTitle className="text-xl">{copy.title}</EmptyTitle>
      <EmptyDescription>{copy.description}</EmptyDescription>
      <EmptyActions>
        <Button type="button" variant="outline" onClick={onClear}>
          {query.trim() === '' ? 'Show all workflows' : 'Clear filter'}
        </Button>
      </EmptyActions>
    </Empty>
  );
}
