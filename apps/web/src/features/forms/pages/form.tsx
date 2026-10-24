import { useEffect } from 'react';
import { describeCoordinatedEvent } from '@/features/trigger-events/presentation.public';
import { ThankYouMessage } from '../components/thank-you';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type {
  FormSchemaResponse,
  FormSubmissionResponse,
  FormSubmissionRequest,
} from '@pertexo/contracts';
import { FinishedThread } from '@/components/patterns/states/thread-illustrations';
import { Status } from '@/components/ui/status';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryView } from '@/components/patterns/states/query-view';
import { isApiError } from '@/lib/api/error';
import { FormResponse } from '../components/response';
import { sendForm, type FormScope } from '../data/forms.api';
import { formQueryOptions } from '../data/forms.queries';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
function formUnavailable(error: unknown) {
  if (!isApiError(error) || error.problem?.code !== 'form.unavailable')
    return undefined;
  return (
    <Notice tone="warning">
      This form is not available. Its owner may have turned it off or changed
      the link.
    </Notice>
  );
}

export function FormPage({ scope }: Readonly<{ scope: FormScope }>) {
  const query = useQuery(formQueryOptions(scope));
  const command = useRetainedCommand(
    (body: FormSubmissionRequest, key: string) => sendForm(scope, body, key),
  );
  async function reload() {
    const loaded = await query.refetch();
    if (loaded.isSuccess) command.reset();
  }
  if (command.data?.accepted)
    return <SubmissionReceipt scope={scope} receipt={command.data} />;
  if (command.data !== undefined && 'coordinated' in command.data) {
    const look = describeCoordinatedEvent(command.data);
    return (
      <section className="flex flex-col gap-4">
        <h1>
          <Status tone={look.tone}>{look.label}</Status>
        </h1>
        <p>{look.detail}</p>
        <Button variant="outline" onClick={command.reset}>
          Send another response
        </Button>
      </section>
    );
  }
  return (
    <QueryView
      query={query}
      resource="The form"
      loading={<Skeleton className="h-72 w-full" />}
      failure={formUnavailable}
    >
      {(schema) => (
        <PublishedForm
          key={schema.versionId}
          command={command}
          schema={schema}
          reload={reload}
        />
      )}
    </QueryView>
  );
}
function SubmissionReceipt({
  scope,
  receipt,
}: Readonly<{
  scope: FormScope;
  receipt: Extract<FormSubmissionResponse, { accepted: true }>;
}>) {
  useEffect(() => {
    if (receipt.redirectUrl !== undefined)
      window.location.replace(receipt.redirectUrl);
  }, [receipt.redirectUrl]);
  return (
    <section className="flex flex-col gap-4">
      <FinishedThread />
      <h1 className="font-heading text-3xl font-semibold">Response sent</h1>
      <Status
        tone="success"
        className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
      >
        <ThankYouMessage message={receipt.thankYouMessage} />
      </Status>
      {receipt.redirectUrl === undefined ? null : (
        <a
          href={receipt.redirectUrl}
          rel="noreferrer"
          referrerPolicy="no-referrer"
          className="text-sm underline underline-offset-4"
        >
          Continue
        </a>
      )}
      {scope.target.kind === 'member' && receipt.runId !== undefined ? (
        <Link
          to="/w/$workspaceId/runs/$runId"
          params={{
            workspaceId: scope.target.workspaceId,
            runId: receipt.runId,
          }}
          className="text-sm underline underline-offset-4"
        >
          Open run
        </Link>
      ) : null}
    </section>
  );
}
type SubmissionCommand = ReturnType<
  typeof useRetainedCommand<FormSubmissionRequest, FormSubmissionResponse>
>;
function PublishedForm({
  command,
  schema,
  reload,
}: Readonly<{
  command: SubmissionCommand;
  schema: FormSchemaResponse;
  reload: () => Promise<void>;
}>) {
  const changed =
    isApiError(command.cause) && command.cause.problem?.code === 'form.changed';
  const { versionId, form } = schema;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="break-words font-heading text-3xl font-semibold [overflow-wrap:anywhere]">
          {form.title}
        </h1>
        {form.instructions === '' ? null : (
          <p className="whitespace-pre-wrap break-words text-muted-foreground">
            {form.instructions}
          </p>
        )}
      </header>
      <FormResponse
        fields={form.fields}
        pending={command.pending}
        disabled={command.uncertain || changed}
        submitLabel="Send response"
        onSubmit={(values) => command.send({ versionId, values })}
      />
      {command.data?.accepted === false ? (
        <Notice tone="warning">
          This workflow is busy. Try again shortly. Your response has not been
          sent.
        </Notice>
      ) : null}
      {command.error === undefined ? null : (
        <Notice
          tone={command.uncertain ? 'warning' : 'destructive'}
          action={formRecoveryAction({ command, changed, reload })}
        >
          {command.error}
        </Notice>
      )}
    </div>
  );
}

function formRecoveryAction({
  command,
  changed,
  reload,
}: Readonly<{
  command: SubmissionCommand;
  changed: boolean;
  reload: () => Promise<void>;
}>) {
  if (command.uncertain)
    return (
      <Button
        type="button"
        variant="outline"
        disabled={command.pending || command.expired}
        onClick={command.retry}
      >
        Retry same response
      </Button>
    );
  if (changed)
    return (
      <Button type="button" variant="outline" onClick={() => void reload()}>
        Reload form
      </Button>
    );
  return undefined;
}
