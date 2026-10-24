import { useId, useState } from 'react';
import {
  workflowFolderNameInputSchema,
  type WorkflowFolder,
} from '@pertexo/contracts';
import { ActionDialog } from '@/components/patterns/actions/action-dialog';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import type { WorkflowOrganizationCommand } from '../../../hooks/use-workflow-organization-command';
import type { useAudienceMove } from '../../../hooks/use-audience-move';
import { folderMoveDestinations } from '../../../model/organization/folder-navigation';
import { AudienceMoveReview } from './audience-review';
import { WorkflowFolderPicker } from './picker';

type Audience = ReturnType<typeof useAudienceMove>;
const UNCONFIRMED =
  'We couldn’t confirm this change. Try again; it won’t be applied twice.';

function CommandProblem({
  command,
}: Readonly<{ command: WorkflowOrganizationCommand }>) {
  if (command.retryAvailable)
    return <Notice tone="warning">{UNCONFIRMED}</Notice>;
  return command.error === undefined ? null : (
    <Notice tone="destructive">{command.error}</Notice>
  );
}

/** Create a folder at the current level, or rename one. */
export function FolderNameDialog({
  workspaceId,
  target,
  command,
  onClose,
}: Readonly<{
  workspaceId: string;
  target:
    | Readonly<{ kind: 'create'; parent: WorkflowFolder | null }>
    | Readonly<{ kind: 'rename'; folder: WorkflowFolder }>;
  command: WorkflowOrganizationCommand;
  onClose: () => void;
}>) {
  const id = useId();
  const fields = useFieldValidation<'name'>();
  const [name, setName] = useState(
    target.kind === 'rename' ? target.folder.name : '',
  );
  const nameError = (value: string) => {
    if (workflowFolderNameInputSchema.safeParse(value).success) {
      return undefined;
    }
    if (value.trim() === '') {
      return 'Enter a folder name.';
    }
    return 'Use a shorter name, up to 128 characters, on one line.';
  };
  const locked = command.pending || command.retryAvailable;
  const submit = () => {
    if (locked || !fields.submit({ name: nameError(name) })) return;
    void command.start(
      target.kind === 'create'
        ? {
            workspaceId,
            kind: 'create-folder',
            idempotencyKey: crypto.randomUUID(),
            body: { name, parentId: target.parent?.id ?? null },
          }
        : {
            workspaceId,
            kind: 'rename-folder',
            folderId: target.folder.id,
            idempotencyKey: crypto.randomUUID(),
            body: { name, expectedFolderRevision: target.folder.revision },
          },
    );
  };
  return (
    <ActionDialog
      title={
        target.kind === 'create' ? 'New folder' : `Rename ${target.folder.name}`
      }
      description={folderPlacementDescription(target)}
      locked={command.pending}
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            disabled={command.pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <ProgressButton
            type="submit"
            form={id}
            variant="primary"
            pending={command.pending}
            pendingLabel={target.kind === 'create' ? 'Creating…' : 'Saving…'}
            onClick={
              command.retryAvailable
                ? (event) => {
                    event.preventDefault();
                    void command.retry();
                  }
                : undefined
            }
          >
            {folderSubmitLabel({
              retryAvailable: command.retryAvailable,
              kind: target.kind,
            })}
          </ProgressButton>
        </>
      }
    >
      <form
        id={id}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <LabelledField
          id={`${id}-name`}
          label="Name"
          error={fields.error('name')}
        >
          {(control) => (
            <Input
              {...control}
              ref={fields.register('name')}
              name="folder-name"
              autoComplete="off"
              value={name}
              disabled={locked}
              onChange={(event) => {
                setName(event.target.value);
                fields.change('name', nameError(event.target.value));
              }}
            />
          )}
        </LabelledField>
      </form>
      <CommandProblem command={command} />
    </ActionDialog>
  );
}

/** Move a folder and everything inside it. A move that loosens access is reviewed first. */
export function FolderMoveDialog({
  workspaceId,
  folder,
  folders,
  command,
  audience,
  onClose,
}: Readonly<{
  workspaceId: string;
  folder: WorkflowFolder;
  folders: readonly WorkflowFolder[];
  command: WorkflowOrganizationCommand;
  audience: Audience;
  onClose: () => void;
}>) {
  const [parentId, setParentId] = useState<string | null>(folder.parentId);
  const busy = command.pending || audience.pending;
  const reviewing = audience.review !== undefined;
  return (
    <ActionDialog
      title={`Move ${folder.name}`}
      description="Everything inside moves with it."
      locked={busy}
      onClose={() => {
        audience.cancel();
        onClose();
      }}
      footer={
        reviewing ? null : (
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <ProgressButton
              type="button"
              variant="primary"
              pending={busy}
              pendingLabel="Moving…"
              disabled={!command.retryAvailable && parentId === folder.parentId}
              onClick={() => {
                if (command.retryAvailable) {
                  void command.retry();
                  return;
                }
                void audience.begin({
                  workspaceId,
                  kind: 'move-folder',
                  folderId: folder.id,
                  idempotencyKey: crypto.randomUUID(),
                  body: { parentId, expectedFolderRevision: folder.revision },
                });
              }}
            >
              {command.retryAvailable ? 'Try again' : 'Move folder'}
            </ProgressButton>
          </>
        )
      }
    >
      {reviewing && audience.review !== undefined ? (
        <AudienceMoveReview
          key={audience.review.report.items.map((item) => item.token).join(':')}
          report={audience.review.report}
          administrator
          pending={command.pending}
          onConfirm={() => {
            void audience.confirm();
          }}
          onCancel={audience.cancel}
        />
      ) : (
        <WorkflowFolderPicker
          folders={folderMoveDestinations(folders, folder)}
          value={parentId}
          onChange={setParentId}
          disabled={busy || command.retryAvailable}
          label="Move to"
          rootLabel="Top level"
        />
      )}
      {audience.error === undefined ? null : (
        <Notice tone="warning">{audience.error}</Notice>
      )}
      <CommandProblem command={command} />
    </ActionDialog>
  );
}

export function FolderDeleteDialog({
  workspaceId,
  folder,
  command,
  onClose,
}: Readonly<{
  workspaceId: string;
  folder: WorkflowFolder;
  command: WorkflowOrganizationCommand;
  onClose: () => void;
}>) {
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      tone="destructive"
      title={`Delete ${folder.name}?`}
      description="Only an empty folder can be deleted. Move its workflows, including archived ones, and its folders out first."
      confirmLabel="Delete folder"
      pendingLabel="Deleting…"
      pending={command.pending}
      locked={command.pending}
      error={command.retryAvailable ? UNCONFIRMED : command.error}
      errorTone={command.retryAvailable ? 'warning' : 'destructive'}
      {...(command.retryAvailable
        ? {
            unconfirmed: {
              onRetry: () => command.retry(),
              onDismiss: onClose,
            },
          }
        : {})}
      onConfirm={() =>
        command.start({
          workspaceId,
          kind: 'delete-folder',
          folderId: folder.id,
          idempotencyKey: crypto.randomUUID(),
          body: { expectedFolderRevision: folder.revision },
        })
      }
    />
  );
}

function folderPlacementDescription(
  target:
    | Readonly<{ kind: 'create'; parent: WorkflowFolder | null }>
    | Readonly<{ kind: 'rename'; folder: WorkflowFolder }>,
) {
  if (target.kind === 'rename') return 'Workflows inside keep their place.';
  if (target.parent === null) return 'It appears at the top of your workflows.';
  return `It appears inside ${target.parent.name}, with the same access.`;
}
function folderSubmitLabel(
  input: Readonly<{ retryAvailable: boolean; kind: 'create' | 'rename' }>,
) {
  if (input.retryAvailable) return 'Try again';
  return input.kind === 'create' ? 'Create folder' : 'Save name';
}
