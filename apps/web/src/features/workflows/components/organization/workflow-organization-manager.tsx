import { useId, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type {
  WorkflowFolder,
  WorkflowTag,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { Separator } from '@/components/ui/separator';
import { LoadMore } from '@/components/patterns/load-more';
import {
  workflowFoldersQueryOptions,
  workflowTagsInfiniteQueryOptions,
} from '../../organization.queries';
import {
  freezeWorkflowOrganizationAttempt,
  type WorkflowOrganizationAttempt,
} from '../../model/workflow-organization';
import { useWorkflowOrganizationCommand } from '../../use-workflow-organization-command';
import { WorkflowFolderPicker } from './workflow-folder-picker';
import { OrganizationCommandFeedback } from './organization-command-feedback';
import { WorkflowTagCleanup } from './workflow-tag-cleanup';

type ManagerProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  onClose: () => void;
}>;
type StartCommand = (attempt: WorkflowOrganizationAttempt) => void;

export function WorkflowOrganizationManager(props: ManagerProps) {
  if (
    props.workspace.status !== 'active' ||
    !['owner', 'admin'].includes(props.workspace.role)
  )
    return (
      <Notice
        tone="warning"
        action={<Button onClick={props.onClose}>Close</Button>}
      >
        Only owners and admins in an active workspace can manage folders and
        tags.
      </Notice>
    );
  return (
    <OrganizationManagerContent
      key={`${props.userId}:${props.workspace.id}`}
      {...props}
    />
  );
}

function OrganizationManagerContent({
  apiClient,
  userId,
  workspace,
  onClose,
}: ManagerProps) {
  const folders = useQuery(
    workflowFoldersQueryOptions(apiClient, userId, workspace.id),
  );
  const tags = useInfiniteQuery(
    workflowTagsInfiniteQueryOptions(apiClient, userId, workspace.id),
  );
  const command = useWorkflowOrganizationCommand({
    apiClient,
    userId,
    workspace,
    requiredRole: 'admin',
  });
  const [validation, setValidation] = useState<string>();
  const [cleanup, setCleanup] = useState<WorkflowTag>();
  const locked = command.pending || command.retryAvailable || command.denied;
  const start: StartCommand = (attempt) => {
    if (locked) return;
    try {
      const frozen = freezeWorkflowOrganizationAttempt(attempt);
      setValidation(undefined);
      void command.start(frozen);
    } catch {
      setValidation(
        'Check the name, destination and selection. Names must fit their limits; folder names cannot contain control characters.',
      );
    }
  };
  const scope = { workspaceId: workspace.id };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.pending && !command.retryAvailable) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogTitle>Manage workflow organization</DialogTitle>
        <DialogDescription>
          Shared folders and tags help people find workflows. They do not change
          permissions or execution.
        </DialogDescription>
        <div className="mt-6 flex flex-col gap-6">
          <OrganizationCommandFeedback command={command} />
          {cleanup === undefined && !command.denied ? (
            <Button
              type="button"
              variant="outline"
              disabled={locked || folders.isFetching || tags.isFetching}
              onClick={() => {
                command.reset();
                setValidation(undefined);
                void folders.refetch();
                void tags.refetch();
              }}
            >
              Reload current folders and tags
            </Button>
          ) : null}
          {validation === undefined ? null : (
            <Notice tone="destructive">{validation}</Notice>
          )}
          {folders.isError || tags.isError ? (
            <Notice
              tone="destructive"
              action={
                <Button
                  disabled={locked}
                  onClick={() => {
                    void folders.refetch();
                    void tags.refetch();
                  }}
                >
                  Reload organization
                </Button>
              }
            >
              Organization could not be loaded. Management is unavailable until
              current revisions are loaded.
            </Notice>
          ) : null}
          {command.denied ? (
            <Notice tone="warning">
              Organization controls are closed because access changed. Reopen
              the manager only after checking current access.
            </Notice>
          ) : cleanup === undefined ? (
            <>
              <FolderManagement
                folders={folders.data?.items ?? []}
                ready={folders.isSuccess && !folders.isFetching}
                locked={locked}
                scope={scope}
                start={start}
              />
              <Separator />
              <TagManagement
                tags={tags.data?.pages.flatMap((page) => page.items) ?? []}
                ready={tags.isSuccess && !tags.isFetching}
                locked={locked}
                scope={scope}
                start={start}
                onCleanup={(tag) => {
                  command.reset();
                  setCleanup(tag);
                }}
              />
              <LoadMore
                subject="tags"
                hasNextPage={tags.hasNextPage}
                loading={tags.isFetchingNextPage || locked}
                failed={tags.isFetchNextPageError}
                label="Load more tags"
                onLoadMore={() => {
                  if (!locked) void tags.fetchNextPage();
                }}
              />
            </>
          ) : (
            <WorkflowTagCleanup
              apiClient={apiClient}
              userId={userId}
              workspaceId={workspace.id}
              tag={cleanup}
              locked={locked}
              command={command}
              start={start}
              onBack={() => {
                command.reset();
                setCleanup(undefined);
              }}
            />
          )}
          <Button
            type="button"
            variant="outline"
            disabled={command.pending || command.retryAvailable}
            onClick={onClose}
          >
            Close manager
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FolderManagement({
  folders,
  ready,
  locked,
  scope,
  start,
}: Readonly<{
  folders: readonly WorkflowFolder[];
  ready: boolean;
  locked: boolean;
  scope: { workspaceId: string };
  start: StartCommand;
}>) {
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const id = useId();
  const current = folders.find((folder) => folder.id === selected);
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
                disabled={locked}
                onClick={() => {
                  setSelected(folder.id);
                  setName(folder.name);
                  setParentId(folder.parentId);
                  setConfirmDelete(false);
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
            description="Up to 128 UTF-8 bytes. Display casing is kept; sibling names differ only by ASCII casing conflict."
          >
            {(control) => (
              <Input
                {...control}
                value={name}
                disabled={disabled}
                onChange={(event) => {
                  setName(event.target.value);
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
              disabled={disabled || name.trim().length === 0}
              pendingLabel="Saving…"
            >
              {current === undefined ? 'Create folder' : 'Rename folder'}
            </ProgressButton>
            {current === undefined ? null : (
              <>
                <Button
                  type="button"
                  disabled={disabled}
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
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={disabled}
                  onClick={() => {
                    setConfirmDelete(true);
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
                    setName('');
                    setParentId(null);
                    setConfirmDelete(false);
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
            setConfirmDelete(false);
          }}
        >
          New folder
        </Button>
      ) : null}
      {confirmDelete && current !== undefined ? (
        <Notice
          tone="warning"
          title={`Delete ${current.name}?`}
          action={
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                start({
                  ...scope,
                  kind: 'delete-folder',
                  folderId: current.id,
                  idempotencyKey: crypto.randomUUID(),
                  body: { expectedFolderRevision: current.revision },
                });
              }}
            >
              Confirm delete folder
            </Button>
          }
        >
          Deletion requires an empty folder, including archived workflows and
          immediate child folders. Nothing is automatically unfiled.
        </Notice>
      ) : null}
    </section>
  );
}

function TagManagement({
  tags,
  ready,
  locked,
  scope,
  start,
  onCleanup,
}: Readonly<{
  tags: readonly WorkflowTag[];
  ready: boolean;
  locked: boolean;
  scope: { workspaceId: string };
  start: StartCommand;
  onCleanup: (tag: WorkflowTag) => void;
}>) {
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const current = tags.find((tag) => tag.id === selected);
  const disabled =
    locked || !ready || (selected !== undefined && current === undefined);
  const id = useId();
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
            description="Lowercase letters, numbers and single hyphens; at most 32 bytes."
          >
            {(control) => (
              <Input
                {...control}
                value={name}
                disabled={disabled}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </LabelledField>
          <div className="flex flex-wrap gap-2">
            <ProgressButton
              type="submit"
              disabled={disabled || name.trim().length === 0}
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
                    setConfirmDelete(true);
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
      {confirmDelete && current !== undefined ? (
        <Notice
          tone="warning"
          title={`Delete ${current.key}?`}
          action={
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                start({
                  ...scope,
                  kind: 'delete-tag',
                  tagId: current.id,
                  idempotencyKey: crypto.randomUUID(),
                  body: { expectedTagRevision: current.revision },
                });
              }}
            >
              Confirm delete tag
            </Button>
          }
        >
          Up to 50 assignments can be detached atomically. If the tag is used by
          more workflows, review assignments and explicitly clean up selected
          workflows first.
        </Notice>
      ) : null}
    </section>
  );
}
