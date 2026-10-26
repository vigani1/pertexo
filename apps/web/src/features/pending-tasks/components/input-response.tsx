import { useState } from 'react';
import type { PendingTaskDetail } from '@pertexo/contracts';
import type { FormValues } from '@pertexo/workflow-model';
import { FormResponse, newUploadSession } from '@/features/forms/fields.public';
import { ResponseFiles } from '@/features/artifacts/public';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format/time';
import { useTaskResponse } from '../data/use-response';
import { taskUploadTarget, type TaskScope } from '../data/tasks.api';
import { blockedSentence } from '../model/presentation';
export function InputResponse({
  task,
  scope,
}: Readonly<{
  task: Extract<PendingTaskDetail, { kind: 'input_request' }>;
  scope: TaskScope;
}>) {
  // One response session: the files attached here and the response share it.
  const [session] = useState(newUploadSession);
  const command = useTaskResponse(scope, task.id, session);
  return (
    <div className="flex flex-col gap-4">
      {task.output === null ? null : (
        <section className="rounded-xl border border-border p-5">
          <h2 className="font-medium">
            {task.completedByName ?? 'Workspace member'} sent this response
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDateTime(task.output.submittedAt)}
          </p>
          <dl className="mt-4 grid gap-3">
            {task.fields.map((field) => {
              const value = task.output?.values[field.name];
              return value === undefined ? null : (
                <div key={field.name}>
                  <dt className="text-sm text-muted-foreground">
                    {field.label}
                  </dt>
                  <dd className="whitespace-pre-wrap break-words">
                    <ResponseValue value={value} scope={scope} />
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}
      {!task.canRespond && task.status === 'pending' ? (
        <Notice>{blockedSentence(task)}</Notice>
      ) : null}
      {task.status === 'pending' ? (
        <FormResponse
          fields={task.fields}
          initialValues={task.prefill}
          pending={command.pending}
          disabled={!task.canRespond || command.uncertain}
          uploads={taskUploadTarget(scope, task.id, session)}
          onSubmit={(values) => command.send({ values })}
        />
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
                Retry same response
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

function ResponseValue({
  value,
  scope,
}: Readonly<{ value: FormValues[string]; scope: TaskScope }>) {
  if (!Array.isArray(value)) return String(value);
  const choices = value.filter((item) => typeof item === 'string');
  if (choices.length < value.length)
    return (
      <ResponseFiles
        value={value}
        apiClient={scope.apiClient}
        userId={scope.userId}
        workspaceId={scope.workspaceId}
      />
    );
  return (
    <ul className="list-inside list-disc">
      {choices.map((option) => (
        <li key={option}>{option}</li>
      ))}
    </ul>
  );
}
