import {
  workflowTagKeyInputSchema,
  type WorkflowTag,
} from '@pertexo/contracts';
import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { Button } from '@/components/ui/button';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { WorkflowOrganizationAttempt } from '../../../model/organization/requests';
import type { useWorkflowOrganizationCommand } from '../../../hooks/use-workflow-organization-command';

type StartCommand = (attempt: WorkflowOrganizationAttempt) => void;

export function TagManagement({
  tags,
  ready,
  locked,
  scope,
  start,
  onCleanup,
  command,
  pendingKind,
  onConfirmationChange,
}: Readonly<{
  tags: readonly WorkflowTag[];
  ready: boolean;
  locked: boolean;
  scope: { workspaceId: string };
  start: StartCommand;
  onCleanup: (tag: WorkflowTag) => void;
  command: ReturnType<typeof useWorkflowOrganizationCommand>;
  pendingKind: WorkflowOrganizationAttempt['kind'] | undefined;
  onConfirmationChange: (open: boolean) => void;
}>) {
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowTag>();
  const current = tags.find((tag) => tag.id === selected);
  const disabled =
    locked || !ready || (selected !== undefined && current === undefined);
  const id = useId();
  const fields = useFieldValidation<'name'>();
  const nameError = (value: string) =>
    workflowTagKeyInputSchema.safeParse(value).success
      ? undefined
      : 'Enter a tag key of 1–32 bytes using letters, numbers and single hyphens.';
  const changeConfirmation = (open: boolean) => {
    if (open) command.reset();
    setConfirmDelete(open);
    setDeleteTarget(open ? current : undefined);
    onConfirmationChange(open);
  };
  return (
    <section aria-label="Tag management" className="flex flex-col gap-4">
      <h2 className="font-display text-lg">Tags</h2>
      {tags.length === 0 ? (
        <p>No tags yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tags.map((tag) => (
            <li key={tag.id}>
              <Button
                type="button"
                variant="ghost"
                disabled={locked}
                onClick={() => {
                  setSelected(tag.id);
                  fields.reset();
                  setName(tag.key);
                  setConfirmDelete(false);
                }}
              >
                Edit tag {tag.key}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          if (!fields.submit({ name: nameError(name) })) return;
          start(
            current === undefined
              ? {
                  ...scope,
                  kind: 'create-tag',
                  idempotencyKey: crypto.randomUUID(),
                  body: { key: name },
                }
              : {
                  ...scope,
                  kind: 'rename-tag',
                  tagId: current.id,
                  idempotencyKey: crypto.randomUUID(),
                  body: { key: name, expectedTagRevision: current.revision },
                },
          );
        }}
      >
        <FieldGroup>
          <LabelledField
            id={id}
            label="Tag key"
            error={fields.error('name')}
            description="Lowercase letters, numbers and single hyphens; at most 32 bytes."
          >
            {(control) => (
              <Input
                {...control}
                ref={fields.register('name')}
                value={name}
                disabled={disabled}
                onChange={(event) => {
                  setName(event.target.value);
                  fields.change('name', nameError(event.target.value));
                }}
              />
            )}
          </LabelledField>
          <div className="flex flex-wrap gap-2">
            <ProgressButton
              type="submit"
              disabled={disabled}
              pending={
                command.pending &&
                (pendingKind === 'create-tag' || pendingKind === 'rename-tag')
              }
              pendingLabel="Saving…"
            >
              {current === undefined ? 'Create tag' : 'Rename tag'}
            </ProgressButton>
            {current === undefined ? null : (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={disabled}
                  onClick={() => {
                    changeConfirmation(true);
                  }}
                >
                  Delete tag
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    onCleanup(current);
                  }}
                >
                  Review tag assignments
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    setSelected(undefined);
                    fields.reset();
                    setName('');
                    setConfirmDelete(false);
                  }}
                >
                  New tag
                </Button>
              </>
            )}
          </div>
        </FieldGroup>
      </form>
      {selected !== undefined && current === undefined ? (
        <Button
          type="button"
          variant="outline"
          disabled={locked || !ready}
          onClick={() => {
            setSelected(undefined);
            setName('');
            setConfirmDelete(false);
          }}
        >
          New tag
        </Button>
      ) : null}
      {confirmDelete && deleteTarget !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={changeConfirmation}
          tone="destructive"
          title={`Delete ${deleteTarget.key}?`}
          description="Deletion also removes assignments from archived workflows. Up to 50 assignments can be detached together. If the tag is used by more workflows, review assignments and explicitly clean up selected workflows first."
          pending={command.pending && pendingKind === 'delete-tag'}
          pendingLabel="Deleting…"
          locked={command.pending || command.retryAvailable}
          confirmDisabled={
            command.denied ||
            (!command.retryAvailable &&
              (disabled ||
                command.error !== undefined ||
                command.result !== undefined))
          }
          confirmLabel={
            command.retryAvailable
              ? 'Retry exact command'
              : 'Confirm delete tag'
          }
          error={command.error}
          errorTone={command.retryAvailable ? 'warning' : 'destructive'}
          onConfirm={
            command.retryAvailable
              ? command.retry
              : () => {
                  if (current === undefined) return;
                  start({
                    ...scope,
                    kind: 'delete-tag',
                    tagId: deleteTarget.id,
                    idempotencyKey: crypto.randomUUID(),
                    body: { expectedTagRevision: deleteTarget.revision },
                  });
                }
          }
        >
          {command.result === undefined ? null : (
            <Notice tone="success">
              Command completed. Current organization is being reloaded.
            </Notice>
          )}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
