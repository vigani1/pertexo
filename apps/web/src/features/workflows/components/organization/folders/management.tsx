import {
  workflowFolderNameInputSchema,
  type WorkflowFolder,
} from '@pertexo/contracts';
import { WorkflowFolderPicker } from './picker';
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

export function FolderManagement({
  folders,
  ready,
  locked,
  scope,
  start,
  command,
  pendingKind,
  onConfirmationChange,
}: Readonly<{
  folders: readonly WorkflowFolder[];
  ready: boolean;
  locked: boolean;
  scope: { workspaceId: string };
  start: StartCommand;
  command: ReturnType<typeof useWorkflowOrganizationCommand>;
  pendingKind: WorkflowOrganizationAttempt['kind'] | undefined;
  onConfirmationChange: (open: boolean) => void;
}>) {
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowFolder>();
  const id = useId();
  const fields = useFieldValidation<'name'>();
  const current = folders.find((folder) => folder.id === selected);
  const nameError = (value: string) =>
    workflowFolderNameInputSchema.safeParse(value).success
      ? undefined
      : 'Enter a folder name of 1–128 UTF-8 bytes without control characters.';
  const changeConfirmation = (open: boolean) => {
    if (open) command.reset();
    setDeleteTarget(open ? current : undefined);
    onConfirmationChange(open);
  };
  const disabled =
    locked || !ready || (selected !== undefined && current === undefined);
  return (
    <section aria-label="Folder management" className="flex flex-col gap-4">
      <h2 className="font-display text-lg">Folders</h2>
      {folders.length === 0 ? (
        <p>No folders yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {folders.map((folder) => (
            <li key={folder.id}>
              <Button
                type="button"
                variant="ghost"
                className="h-auto min-h-9 max-w-full py-2 whitespace-normal wrap-anywhere pointer-coarse:h-auto pointer-coarse:min-h-10"
                disabled={locked}
                onClick={() => {
                  setSelected(folder.id);
                  fields.reset();
                  setName(folder.name);
                  setParentId(folder.parentId);
                  setDeleteTarget(undefined);
                }}
              >
                Edit folder {folder.name}
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
                  kind: 'create-folder',
                  idempotencyKey: crypto.randomUUID(),
                  body: { name, parentId },
                }
              : {
                  ...scope,
                  kind: 'rename-folder',
                  folderId: current.id,
                  idempotencyKey: crypto.randomUUID(),
                  body: { name, expectedFolderRevision: current.revision },
                },
          );
        }}
      >
        <FieldGroup>
          <LabelledField
            id={id}
            label="Folder name"
            error={fields.error('name')}
            description="Up to 128 UTF-8 bytes. Display casing is kept; sibling names differ only by ASCII casing conflict."
          >
            {(control) => (
              <Input
                {...control}
                ref={fields.register('name')}
                name="folder-name"
                autoComplete="off"
                value={name}
                disabled={disabled}
                onChange={(event) => {
                  setName(event.target.value);
                  fields.change('name', nameError(event.target.value));
                }}
              />
            )}
          </LabelledField>
          <WorkflowFolderPicker
            folders={folders}
            value={parentId}
            onChange={setParentId}
            disabled={disabled}
            label="Parent folder"
          />
          <div className="flex flex-wrap gap-2">
            <ProgressButton
              type="submit"
              disabled={disabled}
              pending={
                command.pending &&
                (pendingKind === 'create-folder' ||
                  pendingKind === 'rename-folder')
              }
              pendingLabel="Saving…"
            >
              {current === undefined ? 'Create folder' : 'Rename folder'}
            </ProgressButton>
            {current === undefined ? null : (
              <>
                <ProgressButton
                  type="button"
                  disabled={disabled}
                  pending={command.pending && pendingKind === 'move-folder'}
                  pendingLabel="Moving…"
                  onClick={() => {
                    start({
                      ...scope,
                      kind: 'move-folder',
                      folderId: current.id,
                      idempotencyKey: crypto.randomUUID(),
                      body: {
                        parentId,
                        expectedFolderRevision: current.revision,
                      },
                    });
                  }}
                >
                  Move folder
                </ProgressButton>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={disabled}
                  onClick={() => {
                    changeConfirmation(true);
                  }}
                >
                  Delete folder
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    setSelected(undefined);
                    fields.reset();
                    setName('');
                    setParentId(null);
                    setDeleteTarget(undefined);
                  }}
                >
                  New folder
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
            setParentId(null);
            setDeleteTarget(undefined);
          }}
        >
          New folder
        </Button>
      ) : null}
      {deleteTarget !== undefined ? (
        <FolderDeleteConfirmation
          target={deleteTarget}
          command={command}
          pendingKind={pendingKind}
          disabled={disabled}
          onOpenChange={changeConfirmation}
          onDelete={() => {
            if (current === undefined) return;
            start({
              ...scope,
              kind: 'delete-folder',
              folderId: deleteTarget.id,
              idempotencyKey: crypto.randomUUID(),
              body: { expectedFolderRevision: deleteTarget.revision },
            });
          }}
        />
      ) : null}
    </section>
  );
}

function FolderDeleteConfirmation({
  target,
  command,
  pendingKind,
  disabled,
  onOpenChange,
  onDelete,
}: Readonly<{
  target: WorkflowFolder;
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
      title={`Delete ${target.name}?`}
      description="Deletion requires an empty folder, including archived workflows and immediate child folders. Nothing is automatically unfiled."
      pending={command.pending && pendingKind === 'delete-folder'}
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
        command.retryAvailable ? 'Retry exact command' : 'Confirm delete folder'
      }
      error={command.error}
      errorTone={command.retryAvailable ? 'warning' : 'destructive'}
      onConfirm={command.retryAvailable ? command.retry : onDelete}
    >
      {command.result === undefined ? null : (
        <Notice tone="success">
          Command completed. Current organization is being reloaded.
        </Notice>
      )}
    </ConfirmDialog>
  );
}
