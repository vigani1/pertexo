import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { workspaceRenameRequestSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { PencilIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { ProgressButton } from '@/components/ui/progress-button';
import { LabelledField } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceRename } from '../../mutations/use-workspace-rename';

function nameError(name: string): string | undefined {
  return workspaceRenameRequestSchema.shape.name.safeParse(name).success
    ? undefined
    : 'Name the workspace in 1 to 128 characters.';
}

type Editing = Readonly<{ startedAs: string; submittedRevision?: number }>;

/**
 * The workspace name with a pencil to edit it in place. Save sends the
 * revision the edit started from; if someone renamed it meanwhile, people
 * choose between their name and the newer one.
 */
export function WorkspaceNameField({
  apiClient,
  userId,
  workspace,
  onWorkspaceChanged,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  onWorkspaceChanged: () => void;
  onAccessLost: () => void;
}>) {
  const id = useId();
  const notifications = useNotifications();
  const canRename =
    workspace.status === 'active' &&
    workspace.capabilities.includes('workspace:manage');
  const [editing, setEditing] = useState<Editing>();
  const [name, setName] = useState(workspace.name);
  const validation = useFieldValidation<'name'>();
  const command = useWorkspaceRename({
    apiClient,
    userId,
    workspaceId: workspace.id,
    onChanged: (renamed) => {
      setEditing(undefined);
      validation.reset();
      notifications.success({ title: `Renamed to ${renamed}` });
      onWorkspaceChanged();
    },
    onReloaded: onWorkspaceChanged,
    onAccessLost,
  });

  function stopEditing() {
    setEditing(undefined);
    setName(workspace.name);
    validation.reset();
    command.dismiss();
    command.clearError();
  }

  function save(expectedRevision: number) {
    if (!validation.submit({ name: nameError(name) })) return;
    const parsed = workspaceRenameRequestSchema.parse({
      name,
      expectedRevision,
    });
    if (
      parsed.name === workspace.name &&
      expectedRevision === workspace.revision
    ) {
      stopEditing();
      return;
    }
    setName(parsed.name);
    setEditing((current) => ({
      startedAs: current?.startedAs ?? workspace.name,
      submittedRevision: expectedRevision,
    }));
    void command.start({ body: parsed, idempotencyKey: crypto.randomUUID() });
  }

  if (editing === undefined)
    return (
      <NameDisplay
        name={workspace.name}
        canRename={canRename}
        onEdit={() => {
          setName(workspace.name);
          setEditing({ startedAs: workspace.name });
        }}
      />
    );

  const conflict = command.error?.kind === 'conflict';
  const latestLoaded =
    conflict &&
    editing.submittedRevision !== undefined &&
    workspace.revision !== editing.submittedRevision;
  const locked = command.pending || command.retryAvailable || command.accepted;

  return (
    <form
      noValidate
      className="flex max-w-xl flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (command.retryAvailable) void command.retry();
        else if (command.accepted) void command.refresh();
        else save(workspace.revision);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !locked) stopEditing();
      }}
    >
      <LabelledField
        id={`${id}-name`}
        label="Workspace name"
        error={validation.error('name')}
        thread={validation.thread('name')}
      >
        {(control) => (
          <Input
            {...control}
            ref={validation.register('name')}
            autoComplete="off"
            autoFocus
            maxLength={128}
            value={name}
            disabled={locked}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setName(next);
              command.clearError();
              validation.change('name', nameError(next));
            }}
            onBlur={() => {
              validation.blur('name', nameError(name));
            }}
          />
        )}
      </LabelledField>
      {command.error === undefined ? null : (
        <Notice
          role="alert"
          tone={conflict || command.retryAvailable ? 'warning' : 'destructive'}
        >
          {latestLoaded
            ? meanwhileMessage(workspace.name, editing.startedAs)
            : command.error.message}
        </Notice>
      )}
      {conflict ? (
        <ConflictActions
          latestLoaded={latestLoaded}
          onUseTheirs={stopEditing}
          onKeepMine={() => {
            command.clearError();
            save(workspace.revision);
          }}
          onLoadLatest={() => {
            void command.reloadLatest();
          }}
        />
      ) : (
        <SaveActions command={command} onCancel={stopEditing} />
      )}
    </form>
  );
}

function meanwhileMessage(current: string, startedAs: string): string {
  return current === startedAs
    ? 'This workspace changed while you were editing.'
    : `Renamed to “${current}” meanwhile.`;
}

function NameDisplay({
  name,
  canRename,
  onEdit,
}: Readonly<{ name: string; canRename: boolean; onEdit: () => void }>) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 break-all text-sm font-semibold">{name}</span>
      {canRename ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Rename workspace"
          onClick={onEdit}
        >
          <PencilIcon aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

/** Someone renamed it meanwhile: load their name, then keep either. */
function ConflictActions({
  latestLoaded,
  onUseTheirs,
  onKeepMine,
  onLoadLatest,
}: Readonly<{
  latestLoaded: boolean;
  onUseTheirs: () => void;
  onKeepMine: () => void;
  onLoadLatest: () => void;
}>) {
  if (!latestLoaded)
    return (
      <Button
        type="button"
        variant="default"
        className="self-start"
        onClick={onLoadLatest}
      >
        Load the latest name
      </Button>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="ghost" onClick={onUseTheirs}>
        Use theirs
      </Button>
      <Button type="button" variant="default" onClick={onKeepMine}>
        Keep mine
      </Button>
    </div>
  );
}

function SaveActions({
  command,
  onCancel,
}: Readonly<{
  command: Pick<
    ReturnType<typeof useWorkspaceRename>,
    'accepted' | 'pending' | 'refreshPending' | 'retryAvailable'
  >;
  onCancel: () => void;
}>) {
  let label = 'Save';
  if (command.retryAvailable) label = 'Try again';
  else if (command.accepted) label = 'Refresh';
  return (
    <div className="flex flex-wrap gap-2">
      {command.accepted ? null : (
        <Button
          type="button"
          variant="ghost"
          disabled={command.pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
      )}
      <ProgressButton
        type="submit"
        variant="default"
        pending={command.pending || command.refreshPending}
        pendingLabel={command.pending ? 'Saving…' : 'Refreshing…'}
      >
        {label}
      </ProgressButton>
    </div>
  );
}
