import { useRef, useState, type SyntheticEvent } from 'react';
import { workflowCreateRequestSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/lib/api/client';
import { workflowCreateErrorMessage } from './workflow-errors';
import { workflowKeys } from './workflows.queries';
import { createWorkflowMutationOptions } from './workflows.mutations';

type CreateWorkflowDialogProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  triggerLabel?: string;
}>;

type Attempt = Readonly<{ name: string; idempotencyKey: string }>;

export function CreateWorkflowDialog({
  apiClient,
  userId,
  workspaceId,
  triggerLabel = 'Create workflow',
}: CreateWorkflowDialogProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const attempt = useRef<Attempt | undefined>(undefined);
  const mutation = useMutation({
    ...createWorkflowMutationOptions(apiClient, workspaceId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspaceId),
      });
      attempt.current = undefined;
      setName('');
      setOpen(false);
    },
  });

  function resetForName(nextName: string) {
    if (mutation.isPending) return;
    setName(nextName);
    setValidationError(undefined);
    mutation.reset();
    if (attempt.current?.name !== nextName.trim()) attempt.current = undefined;
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = workflowCreateRequestSchema.safeParse({ name });
    if (!parsed.success) {
      setValidationError('Enter a workflow name between 1 and 128 characters.');
      return;
    }
    const currentAttempt =
      attempt.current?.name === parsed.data.name
        ? attempt.current
        : { name: parsed.data.name, idempotencyKey: crypto.randomUUID() };
    attempt.current = currentAttempt;
    mutation.mutate(currentAttempt);
  }

  return (
    <>
      <Button
        type="button"
        variant="solid"
        onClick={() => {
          setOpen(true);
        }}
      >
        {triggerLabel}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!mutation.isPending) setOpen(nextOpen);
        }}
      >
        <DialogContent>
          <DialogTitle>Create a workflow</DialogTitle>
          <DialogDescription>
            Start with a clear name. Nodes and connections are configured in the
            editor later.
          </DialogDescription>
          <form className="mt-6" onSubmit={submit}>
            <Field
              data-invalid={validationError !== undefined || mutation.isError}
            >
              <FieldLabel htmlFor="workflow-name">Workflow name</FieldLabel>
              <Input
                id="workflow-name"
                name="name"
                autoComplete="off"
                autoFocus
                maxLength={128}
                disabled={mutation.isPending}
                value={name}
                aria-invalid={validationError !== undefined || mutation.isError}
                aria-describedby="workflow-name-help workflow-name-error"
                onChange={(event) => {
                  resetForName(event.target.value);
                }}
              />
              <FieldDescription id="workflow-name-help">
                Use a name your team can recognize quickly.
              </FieldDescription>
              {validationError ? (
                <FieldError id="workflow-name-error">
                  {validationError}
                </FieldError>
              ) : null}
              {mutation.isError ? (
                <FieldError id="workflow-name-error">
                  {workflowCreateErrorMessage(mutation.error)}
                </FieldError>
              ) : null}
            </Field>
            <div className="mt-7 flex justify-end gap-2">
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={mutation.isPending}
                  />
                }
              >
                Cancel
              </DialogClose>
              <Button
                type="submit"
                variant="solid"
                disabled={mutation.isPending}
              >
                {mutation.isPending
                  ? 'Creating…'
                  : mutation.isError
                    ? 'Retry safely'
                    : 'Create workflow'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
