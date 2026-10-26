import type { PendingTaskDetail } from '@pertexo/contracts';
import { FormResponse } from '@/features/forms/fields.public';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format/time';
import { useTaskResponse } from '../data/use-response';
import type { TaskScope } from '../data/tasks.api';
import { blockedSentence } from '../model/presentation';
export function InputResponse({
  task,
  scope,
}: Readonly<{
  task: Extract<PendingTaskDetail, { kind: 'input_request' }>;
  scope: TaskScope;
}>) {
  const command = useTaskResponse(scope, task.id);
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
                    {Array.isArray(value) ? (
                      <ul className="list-inside list-disc">
                        {value.map((option) =>
                          typeof option === 'string' ? (
                            <li key={option}>{option}</li>
                          ) : (
                            <li key={option.file.artifactId}>
                              {option.filename}
                            </li>
                          ),
                        )}
                      </ul>
                    ) : (
                      String(value)
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}
      {!task.canRespond && task.status === 'pending' ? (
        <Notice>{blockedSentence(task.blockedReason)}</Notice>
      ) : null}
      {task.status === 'pending' ? (
        <FormResponse
          fields={task.fields}
          initialValues={task.prefill}
          pending={command.pending}
          disabled={!task.canRespond || command.uncertain}
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
