import { PENDING_TASK_LIMITS } from '@pertexo/workflow-model';
import { useId, useState, type ReactNode } from 'react';
import type { PendingTaskDetail } from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { TaskScope } from '../data/tasks.api';
import { useTaskResponse } from '../data/task-response.mutations';
import { blockedSentence } from '../model/task-presentation';
export function DecisionForm({
  task,
  scope,
  queueNavigation,
}: Readonly<{
  task: Extract<PendingTaskDetail, { kind: 'approval' }>;
  scope: TaskScope;
  queueNavigation: ReactNode;
}>) {
  const id = useId();
  const [comment, setComment] = useState('');
  const command = useTaskResponse(scope, task.id);
  const disabled = command.pending || command.uncertain || !task.canRespond;
  return (
    <div className="flex flex-col gap-4">
      {/* A recorded decision already says how the task ended. */}
      {!task.canRespond && task.output === null ? (
        <Notice>{blockedSentence(task)}</Notice>
      ) : null}
      {task.status === 'pending' ? (
        <>
          <LabelledField
            id={id}
            label="Comment (optional)"
            description="Saved as step output. Members who can read this run can see your comment."
          >
            {(control) => (
              <Textarea
                {...control}
                value={comment}
                maxLength={PENDING_TASK_LIMITS.commentCharacters}
                rows={4}
                disabled={disabled}
                onChange={(event) => {
                  setComment(event.target.value);
                }}
              />
            )}
          </LabelledField>
          <div aria-hidden="true" className="h-28 md:hidden" />
          <div className="max-md:lens max-md:fixed max-md:inset-x-3 max-md:bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.25rem)] max-md:z-30 max-md:rounded-2xl max-md:p-2">
            {queueNavigation}
            <div
              role="group"
              aria-label="Approval decision"
              className="flex flex-wrap gap-3 max-md:[&>button]:flex-1"
            >
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={disabled}
                onClick={() =>
                  void command.send({ decision: 'rejected', comment })
                }
              >
                Reject
              </Button>
              <ProgressButton
                type="button"
                variant="primary"
                size="lg"
                pending={command.pending}
                pendingLabel="Recording…"
                disabled={disabled}
                onClick={() =>
                  void command.send({ decision: 'approved', comment })
                }
              >
                Approve
              </ProgressButton>
            </div>
          </div>
        </>
      ) : null}
      {command.error === undefined ? null : (
        <Notice
          tone={command.uncertain ? 'warning' : 'destructive'}
          action={
            command.uncertain ? (
              <Button
                type="button"
                variant="outline"
                disabled={command.pending}
                onClick={command.retry}
              >
                Retry same decision
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={command.refresh}>
                Refresh request
              </Button>
            )
          }
        >
          {command.error}
        </Notice>
      )}
    </div>
  );
}
