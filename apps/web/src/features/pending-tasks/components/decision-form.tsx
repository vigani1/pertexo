import { useId, useState } from 'react';
import type { PendingTaskDetail } from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { TaskScope } from '../data/tasks.api';
import { useTaskResponse } from '../data/use-response';
import { blockedSentence } from '../model/presentation';
export function DecisionForm({
  task,
  scope,
}: Readonly<{
  task: Extract<PendingTaskDetail, { kind: 'approval' }>;
  scope: TaskScope;
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
                maxLength={2000}
                rows={4}
                disabled={disabled}
                onChange={(event) => {
                  setComment(event.target.value);
                }}
              />
            )}
          </LabelledField>
          <div className="flex flex-wrap gap-3">
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
            ) : undefined
          }
        >
          {command.error}
        </Notice>
      )}
    </div>
  );
}
