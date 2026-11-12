import { isUnconfirmedCommand } from '@/lib/api/commands/command-retry';
import { ExpiredAttemptNotice } from '@/components/patterns/states/expired-attempt-notice';
import { useState, type SyntheticEvent } from 'react';
import { workflowCreateRequestSchema } from '@pertexo/contracts';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import { useCreateWorkflow } from '../../data/workflows.mutations';
import { ExampleCards } from '../templates/example-cards';

function createErrorMessage(error: unknown): string {
  if (isUnconfirmedCommand(error))
    return 'We couldn’t confirm whether the workflow was created. Retrying is safe — it won’t make a duplicate.';
  if (isApiError(error) && error.status === 409)
    return 'This conflicts with the workspace’s current state. Refresh the list, then try again.';
  return describeCommandError(error, 'creating workflows');
}

function nameProblem(value: string): string | undefined {
  return workflowCreateRequestSchema.safeParse({ name: value }).success
    ? undefined
    : 'Give the workflow a name your team will recognize.';
}

/**
 * The New workflow lens: a name for a blank workflow, or one of the
 * ready-made examples, which brings its own name and setup. An unchanged
 * name keeps its idempotency key after an unconfirmed create, so retrying
 * can't make a second workflow.
 */
type NewWorkflowSheetProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (workflowId: string) => void;
  onChooseExample?: ((templateId: string, name?: string) => void) | undefined;
}>;

export function NewWorkflowSheet({
  apiClient,
  userId,
  workspaceId,
  open,
  onOpenChange,
  onCreated,
  onChooseExample,
}: NewWorkflowSheetProps) {
  const notifications = useNotifications();
  const [name, setName] = useState('');
  const validation = useFieldValidation<'name'>();
  const command = useCreateWorkflow(apiClient, userId, workspaceId);

  function changeName(nextName: string) {
    if (command.pending) return;
    setName(nextName);
    command.reset();
    validation.change('name', nameProblem(nextName));
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validation.submit({ name: nameProblem(name) })) return;
    const parsed = workflowCreateRequestSchema.parse({ name });
    let created: Awaited<ReturnType<typeof command.create>>;
    try {
      created = await command.create(parsed);
    } catch {
      return; // The command's error renders in the sheet.
    }
    if (created === undefined) return; // The expired attempt renders its notice.
    setName('');
    validation.reset();
    notifications.success({
      title: 'Workflow created',
      description: created.body.workflow.name,
    });
    onCreated(created.body.workflow.id);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!command.pending) onOpenChange(nextOpen);
      }}
    >
      <SheetContent className="w-[min(30rem,calc(100vw-1.5rem))]">
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => void submit(event)}
        >
          <SheetHeader>
            <SheetTitle>New workflow</SheetTitle>
            <SheetDescription>
              Start blank with a name, or from a ready-made example. Everything
              can change in Build.
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-6">
            <LabelledField
              id="workflow-name"
              label="Workflow name"
              description="For example “Invoice intake” or “Nightly CRM sync”."
              error={validation.error('name')}
            >
              {(control) => (
                <Input
                  {...control}
                  ref={validation.register('name')}
                  name="name"
                  autoComplete="off"
                  autoFocus
                  maxLength={128}
                  disabled={command.pending}
                  value={name}
                  onChange={(event) => {
                    changeName(event.target.value);
                  }}
                />
              )}
            </LabelledField>
            {command.expired ? (
              <ExpiredAttemptNotice onNewAttempt={command.startNewAttempt} />
            ) : null}
            {command.failed && !command.expired ? (
              <Notice tone="destructive">
                {createErrorMessage(command.error)}
              </Notice>
            ) : null}
            {/* After the name: an example is the less common start and
                brings its own name and setup. */}
            {onChooseExample === undefined ? null : (
              <section
                aria-labelledby="new-workflow-examples"
                className="flex flex-col gap-2 border-t border-border pt-5"
              >
                <h3
                  id="new-workflow-examples"
                  className="text-sm font-medium text-foreground"
                >
                  Or start from an example
                </h3>
                <ExampleCards
                  layout="rows"
                  disabled={command.pending}
                  onChoose={(templateId) => {
                    onChooseExample(templateId, name.trim());
                  }}
                />
              </section>
            )}
          </SheetBody>
          <NewWorkflowFooter
            pending={command.pending}
            uncertain={command.uncertain}
          />
        </form>
      </SheetContent>
    </Sheet>
  );
}

function NewWorkflowFooter({
  pending,
  uncertain,
}: Readonly<{ pending: boolean; uncertain: boolean }>) {
  return (
    <SheetFooter>
      <SheetClose
        render={<Button type="button" variant="ghost" disabled={pending} />}
      >
        Cancel
      </SheetClose>
      <ProgressButton
        type="submit"
        variant="primary"
        className="min-w-36"
        pending={pending}
        pendingLabel="Creating…"
      >
        {uncertain ? 'Retry safely' : 'Create workflow'}
      </ProgressButton>
    </SheetFooter>
  );
}
