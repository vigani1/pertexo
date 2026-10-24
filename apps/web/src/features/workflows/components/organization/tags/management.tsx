import {
  workflowTagKeyInputSchema,
  type WorkflowTag,
} from '@pertexo/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { HashIcon } from 'lucide-react';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useNotifications } from '@/components/ui/use-notifications';
import { cn } from '@/lib/utils';
import type { WorkflowOrganizationAttempt } from '../../../model/organization/requests';
import type { useWorkflowOrganizationCommand } from '../../../hooks/use-workflow-organization-command';

type StartCommand = (attempt: WorkflowOrganizationAttempt) => void;
const TAG_HINT = 'Lowercase letters, numbers and hyphens, like eu-region.';
const DONE: Partial<Record<WorkflowOrganizationAttempt['kind'], string>> = {
  'create-tag': 'Tag added',
  'rename-tag': 'Tag renamed',
  'delete-tag': 'Tag deleted',
};

/**
 * Tags as chips. Choosing one opens its editor below; with none chosen the
 * same field adds a new tag.
 */
export function TagManagement({
  tags,
  ready,
  locked,
  scope,
  start,
  onCleanup,
  command,
  pendingKind,
  onReload,
}: Readonly<{
  tags: readonly WorkflowTag[];
  ready: boolean;
  locked: boolean;
  scope: { workspaceId: string };
  start: StartCommand;
  onCleanup: (tag: WorkflowTag) => void;
  command: ReturnType<typeof useWorkflowOrganizationCommand>;
  pendingKind: WorkflowOrganizationAttempt['kind'] | undefined;
  /** Reads the current tags again after a refused change. */
  onReload: () => void;
}>) {
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState('');
  // Deletion stays bound to the tag as it was shown, even if it changes meanwhile.
  const [deleteTarget, setDeleteTarget] = useState<WorkflowTag>();
  const current = tags.find((tag) => tag.id === selected);
  const disabled =
    locked || !ready || (selected !== undefined && current === undefined);
  const id = useId();
  const fields = useFieldValidation<'name'>();
  const nameError = (value: string) => {
    if (workflowTagKeyInputSchema.safeParse(value).success) {
      return undefined;
    }
    if (value.trim() === '') {
      return 'Enter a tag.';
    }
    return `Use up to 32 characters. ${TAG_HINT}`;
  };
  const choose = (tag: WorkflowTag | undefined) => {
    setSelected(tag?.id);
    fields.reset();
    setName(tag?.key ?? '');
  };
  const changeConfirmation = ({ open }: Readonly<{ open: boolean }>) => {
    if (open) command.reset();
    setDeleteTarget(open ? current : undefined);
  };
  const notifications = useNotifications();
  const message = pendingKind === undefined ? undefined : DONE[pendingKind];
  const done =
    message !== undefined &&
    command.result !== undefined &&
    !command.pending &&
    !command.retryAvailable &&
    !command.denied;
  // A confirmed change clears the editor, ready for the next tag.
  const [settled, setSettled] = useState(command.result);
  if (command.result !== settled && done) {
    setSettled(command.result);
    setSelected(undefined);
    setName('');
    setDeleteTarget(undefined);
  }
  // Once per confirmed result: the notifier changes as toasts come and go.
  const announced = useRef(command.result);
  useEffect(() => {
    if (!done || announced.current === command.result) return;
    announced.current = command.result;
    notifications.success({ title: message });
  }, [done, message, notifications, command.result]);
  return (
    <section aria-label="Tags" className="flex flex-col gap-4">
      {tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tags yet. Tags help people find workflows; they never change who
          can open them.
        </p>
      ) : (
        <ul aria-label="Workspace tags" className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li key={tag.id}>
              <button
                type="button"
                aria-pressed={tag.id === selected}
                disabled={locked}
                className={cn(
                  'inline-flex h-8 max-w-full items-center gap-1 rounded-full border px-3 text-sm transition-colors motion-reduce:transition-none disabled:opacity-60',
                  tag.id === selected
                    ? 'border-primary/60 bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
                )}
                onClick={() => {
                  choose(tag.id === selected ? undefined : tag);
                }}
              >
                <HashIcon aria-hidden="true" className="size-3" />
                <span className="truncate">{tag.key}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-3 rounded-lg border border-border bg-card/60 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !fields.submit({ name: nameError(name) })) return;
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
        <LabelledField
          id={id}
          label={current === undefined ? 'New tag' : `Rename #${current.key}`}
          error={fields.error('name')}
          description={TAG_HINT}
        >
          {(control) => (
            <Input
              {...control}
              ref={fields.register('name')}
              name="tag-key"
              autoComplete="off"
              spellCheck={false}
              value={name}
              disabled={disabled}
              onChange={(event) => {
                setName(event.target.value);
                fields.change('name', nameError(event.target.value));
              }}
            />
          )}
        </LabelledField>
        <div className="flex flex-wrap items-center gap-2">
          <ProgressButton
            type="submit"
            variant="primary"
            disabled={disabled}
            pending={
              command.pending &&
              (pendingKind === 'create-tag' || pendingKind === 'rename-tag')
            }
            pendingLabel="Saving…"
          >
            {current === undefined ? 'Add tag' : 'Save name'}
          </ProgressButton>
          {current === undefined ? null : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  onCleanup(current);
                }}
              >
                See workflows using it
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  choose(undefined);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="ml-auto text-destructive hover:text-destructive"
                disabled={disabled}
                onClick={() => {
                  changeConfirmation({ open: true });
                }}
              >
                Delete tag
              </Button>
            </>
          )}
        </div>
      </form>
      {deleteTarget === undefined ? (
        <TagCommandProblem command={command} onReload={onReload} />
      ) : null}
      {deleteTarget === undefined ? null : (
        <TagDeleteConfirmation
          target={deleteTarget}
          command={command}
          pendingKind={pendingKind}
          disabled={disabled}
          onOpenChange={(open) => {
            changeConfirmation({ open });
          }}
          onDelete={() => {
            start({
              ...scope,
              kind: 'delete-tag',
              tagId: deleteTarget.id,
              idempotencyKey: crypto.randomUUID(),
              body: { expectedTagRevision: deleteTarget.revision },
            });
          }}
        />
      )}
    </section>
  );
}

function TagDeleteConfirmation({
  target,
  command,
  pendingKind,
  disabled,
  onOpenChange,
  onDelete,
}: Readonly<{
  target: WorkflowTag;
  command: ReturnType<typeof useWorkflowOrganizationCommand>;
  pendingKind: WorkflowOrganizationAttempt['kind'] | undefined;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
}>) {
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      tone="destructive"
      title={`Delete #${target.key}?`}
      description="It’s removed from every workflow, including archived ones. If more than 50 workflows use it, remove it from some of them first with See workflows using it."
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
      confirmLabel={command.retryAvailable ? 'Try again' : 'Delete tag'}
      error={
        command.retryAvailable
          ? 'We couldn’t confirm this change. Try again; it won’t be applied twice.'
          : command.error
      }
      errorTone={command.retryAvailable ? 'warning' : 'destructive'}
      onConfirm={command.retryAvailable ? command.retry : onDelete}
    />
  );
}

function TagCommandProblem({
  command,
  onReload,
}: Readonly<{
  command: ReturnType<typeof useWorkflowOrganizationCommand>;
  onReload: () => void;
}>) {
  if (command.denied) return null;
  if (command.retryAvailable)
    return (
      <Notice
        tone="warning"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={command.pending}
            onClick={() => void command.retry()}
          >
            Try again
          </Button>
        }
      >
        We couldn’t confirm this change. Try again; it won’t be applied twice.
      </Notice>
    );
  return command.error === undefined ? null : (
    <Notice
      tone="destructive"
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            command.reset();
            onReload();
          }}
        >
          Reload tags
        </Button>
      }
    >
      {command.error}
    </Notice>
  );
}
