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
import { readFailureReason } from '@/lib/api/error-copy';

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
        <Button
          type="button"
          variant="outline"
          disabled={retrying}
          onClick={onRetry}
        >
          <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
          {retrying ? 'Trying again…' : 'Try again'}
        </Button>
      </EmptyActions>
    </Empty>
  );
}
