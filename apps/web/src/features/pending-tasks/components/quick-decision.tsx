import { useState } from 'react';
import type { PendingTaskSummary } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import type { TaskScope } from '../data/tasks.api';
import { useTaskResponse } from '../data/use-response';

/**
 * Approve or reject from the list, without a comment; the request page
 * takes one. Its one failure line sits under the buttons, with the exact
 * retry when the outcome is uncertain.
 */
export function QuickDecision({
  scope,
  task,
}: Readonly<{ scope: TaskScope; task: PendingTaskSummary }>) {
  const command = useTaskResponse(scope, task.id);
  const [sent, setSent] = useState<'approved' | 'rejected'>();
  const disabled = command.pending || command.uncertain;
  function decide(decision: 'approved' | 'rejected') {
    setSent(decision);
    void command.send({ decision, comment: '' });
  }
  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <div className="flex gap-2">
        <ProgressButton
          type="button"
          variant="outline"
          size="sm"
          pending={command.pending && sent === 'rejected'}
          pendingLabel="Rejecting…"
          disabled={disabled}
          aria-label={`Reject ${task.title}`}
          onClick={() => {
            decide('rejected');
          }}
        >
          Reject
        </ProgressButton>
        <ProgressButton
          type="button"
          size="sm"
          pending={command.pending && sent === 'approved'}
          pendingLabel="Approving…"
          disabled={disabled}
          aria-label={`Approve ${task.title}`}
          onClick={() => {
            decide('approved');
          }}
        >
          Approve
        </ProgressButton>
      </div>
      {command.error === undefined ? null : (
        <p
          role="alert"
          className="max-w-72 text-xs text-destructive sm:text-right"
        >
          {command.error}{' '}
          {command.uncertain ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0 text-xs"
              onClick={command.retry}
            >
              Retry same decision
            </Button>
          ) : null}
        </p>
      )}
    </div>
  );
}
