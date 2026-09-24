import { useRef, useState, type SyntheticEvent } from 'react';
import { workflowCreateRequestSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingOrb } from '@/components/ui/loading-orb';
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
import { useNotifications } from '@/components/ui/use-notifications';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import {
  buildStarterGraph,
  type AvailableStarter,
} from '../model/workflow-starters';
import {
  useCreateWorkflow,
  type CreateWorkflowResult,
  type StarterDraftWriter,
} from '../workflows.mutations';
import { StarterChoice, type StartChoice } from './starter-choice';

type Attempt = Readonly<{ name: string; idempotencyKey: string }>;

function createErrorMessage(error: unknown): string {
  if (isUncertainOutcome(error))
    return 'We couldn’t confirm whether the workflow was created. Retrying is safe — it won’t make a duplicate.';
  if (isApiError(error) && error.status === 409)
    return 'This conflicts with the workspace’s current state. Refresh the list, then try again.';
  return describeCommandError(error, 'creating workflows');
}

function isValidName(value: string): boolean {
  return workflowCreateRequestSchema.safeParse({ name: value }).success;
}

/**
 * The New workflow lens: a name, then where to start. The same idempotency
 * key is reused while the name is unchanged, so retrying an uncertain create
 * can't make a second workflow.
 */
export function NewWorkflowSheet({
  apiClient,
  userId,
  workspaceId,
  open,
  starters,
  choice,
  writer,
  onChoiceChange,
  onOpenChange,
  onCreated,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  open: boolean;
  starters: readonly AvailableStarter[];
  choice: StartChoice;
  writer: StarterDraftWriter | undefined;
  onChoiceChange: (choice: StartChoice) => void;
  onOpenChange: (open: boolean) => void;
  onCreated: (workflowId: string) => void;
}>) {
  const notifications = useNotifications();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [validation, setValidation] = useState<'invalid' | 'corrected'>();
  const attempt = useRef<Attempt | undefined>(undefined);
  const mutation = useCreateWorkflow(apiClient, userId, workspaceId);
  const starter = starters.find((candidate) => candidate.id === choice);

  function changeName(nextName: string) {
    if (mutation.isPending) return;
    setName(nextName);
    mutation.reset();
    if (validation !== undefined)
      setValidation(isValidName(nextName) ? 'corrected' : 'invalid');
    if (attempt.current?.name !== nextName.trim()) attempt.current = undefined;
  }

  function announce(result: CreateWorkflowResult) {
    const title = result.created.body.workflow.name;
    if (result.seeded === 'failed')
      notifications.error({
        title: 'Workflow created, but its starter steps weren’t added',
        description: `Add the steps to “${title}” in Build.`,
      });
    else if (result.seeded === 'uncertain')
      notifications.error({
        title: 'We couldn’t confirm whether the starter steps were added',
        description: `Check the canvas of “${title}” before adding them again.`,
      });
    else
      notifications.success({
        title: 'Workflow created',
        description:
          result.seeded === 'saved' ? `${title} · starter steps added` : title,
      });
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = workflowCreateRequestSchema.safeParse({ name });
    if (!parsed.success) {
      setValidation('invalid');
      nameRef.current?.focus();
      return;
    }
    const current =
      attempt.current?.name === parsed.data.name
        ? attempt.current
        : { name: parsed.data.name, idempotencyKey: crypto.randomUUID() };
    attempt.current = current;
    const seed =
      starter === undefined || writer === undefined
        ? undefined
        : { graph: buildStarterGraph(starter), write: writer };
    mutation.mutate(
      { ...current, ...(seed === undefined ? {} : { seed }) },
      {
        onSuccess: (result) => {
          attempt.current = undefined;
          setName('');
          setValidation(undefined);
          announce(result);
          onCreated(result.created.body.workflow.id);
        },
      },
    );
  }

  const invalid = validation === 'invalid';
  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mutation.isPending) onOpenChange(nextOpen);
      }}
    >
      <SheetContent className="w-[min(30rem,calc(100vw-1.5rem))]">
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={submit}
        >
          <SheetHeader>
            <SheetTitle>New workflow</SheetTitle>
            <SheetDescription>
              Name it, then choose how to start. Everything can change in Build.
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-6">
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="workflow-name">Workflow name</FieldLabel>
              <FieldControl state={validation}>
                <Input
                  ref={nameRef}
                  id="workflow-name"
                  name="name"
                  autoComplete="off"
                  autoFocus
                  maxLength={128}
                  disabled={mutation.isPending}
                  value={name}
                  aria-invalid={invalid}
                  aria-describedby={
                    invalid ? 'workflow-name-error' : 'workflow-name-help'
                  }
                  onChange={(event) => {
                    changeName(event.target.value);
                  }}
                />
              </FieldControl>
              {invalid ? (
                <FieldError id="workflow-name-error">
                  Give the workflow a name your team will recognize.
                </FieldError>
              ) : (
                <FieldDescription id="workflow-name-help">
                  For example “Invoice intake” or “Nightly CRM sync”.
                </FieldDescription>
              )}
            </Field>
            {starters.length > 0 && writer !== undefined ? (
              <StarterChoice
                starters={starters}
                value={starter === undefined ? 'blank' : choice}
                disabled={mutation.isPending}
                onChange={onChoiceChange}
              />
            ) : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {createErrorMessage(mutation.error)}
              </p>
            ) : null}
          </SheetBody>
          <SheetFooter>
            <SheetClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  disabled={mutation.isPending}
                />
              }
            >
              Cancel
            </SheetClose>
            <Button
              type="submit"
              variant="primary"
              disabled={mutation.isPending}
              className="min-w-36"
            >
              {mutation.isPending ? <LoadingOrb /> : null}
              {mutation.isPending
                ? 'Creating…'
                : mutation.isError && isUncertainOutcome(mutation.error)
                  ? 'Retry safely'
                  : 'Create workflow'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
