import { useEffect, useId, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowOrganizationProjectionResponse,
  WorkflowFolder,
  WorkflowTag,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import {
  workflowFoldersQueryOptions,
  workflowOrganizationProjectionQueryOptions,
  workflowTagsInfiniteQueryOptions,
} from '../../data/organization/queries';
import { useWorkflowOrganizationCommand } from '../../hooks/use-workflow-organization-command';
import {
  canEditOrganization,
  organizationEditAttempt,
  validOrganizationSelection,
  type OrganizationOperation,
} from './editing';
import { WorkflowFolderPicker } from './folders/picker';
import { WorkflowOrganizationOutcomes } from './outcomes';

type Props = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflows: readonly WorkflowOrganizationProjectionResponse[];
  onClose: () => void;
}>;
const RECOVERY =
  'Exact recovery is available for 24 hours, not an indefinite duplicate-prevention guarantee. Refreshing current state preserves an unresolved request; only a known outcome permits a fresh change. Reloading this page loses its in-memory recovery.';

function useOrganizationEdit({
  apiClient,
  userId,
  workspace,
  workflows,
}: Omit<Props, 'onClose'>) {
  const [selected] = useState(() => [...workflows]);
  const selectionValid = validOrganizationSelection(selected);
  const queryClient = useQueryClient();
  const [preparing, setPreparing] = useState(false);
  const [readError, setReadError] = useState<string>();
  const [formEpoch, setFormEpoch] = useState(0);
  const preparingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const command = useWorkflowOrganizationCommand({
    apiClient,
    userId,
    workspace,
    requiredRole: 'editor',
  });
  const enabled = selectionValid && !command.denied;
  const reads = useQueries({
    queries: selected.map(({ workflow }) => ({
      ...workflowOrganizationProjectionQueryOptions(
        apiClient,
        userId,
        workspace.id,
        workflow.id,
        { include: 'organization' },
      ),
      staleTime: 0,
      enabled,
    })),
  });
  const folders = useQuery({
    ...workflowFoldersQueryOptions(apiClient, userId, workspace.id),
    enabled,
  });
  const tags = useInfiniteQuery({
    ...workflowTagsInfiniteQueryOptions(apiClient, userId, workspace.id),
    enabled,
  });
  const current = reads.flatMap((read) =>
    read.data === undefined ? [] : [read.data],
  );
  const reading =
    reads.some((read) => read.isPending || read.isFetching) ||
    folders.isPending ||
    tags.isPending;
  const failedRead =
    reads.some((read) => read.isError) || folders.isError || tags.isError;
  const locked = preparing || command.pending || command.retryAvailable;
  const feedback =
    command.error ??
    readError ??
    (failedRead
      ? 'Current organization could not be loaded. Refresh before confirming a change.'
      : undefined);

  async function refresh() {
    if (preparingRef.current || command.pending || command.denied) return;
    if (!command.retryAvailable) command.reset();
    setReadError(undefined);
    setPreparing(true);
    preparingRef.current = true;
    try {
      await Promise.all([
        ...reads.map((read) => read.refetch({ throwOnError: true })),
        folders.refetch({ throwOnError: true }),
        tags.refetch({ throwOnError: true }),
      ]);
      if (alive.current) setFormEpoch((epoch) => epoch + 1);
    } catch {
      if (alive.current)
        setReadError(
          'Current organization could not be refreshed. No new command was sent.',
        );
    } finally {
      preparingRef.current = false;
      if (alive.current) setPreparing(false);
    }
  }

  async function confirm(
    operation: OrganizationOperation,
    folderId: string | null,
    tagIds: readonly string[],
  ) {
    if (
      locked ||
      preparingRef.current ||
      command.denied ||
      command.error !== undefined ||
      command.result !== undefined
    )
      return;
    preparingRef.current = true;
    setPreparing(true);
    setReadError(undefined);
    try {
      const latest = await Promise.all(
        selected.map(({ workflow }) =>
          queryClient.query({
            ...workflowOrganizationProjectionQueryOptions(
              apiClient,
              userId,
              workspace.id,
              workflow.id,
              { include: 'organization' },
            ),
            staleTime: 0,
          }),
        ),
      );
      if (!alive.current) return;
      if (!canEditOrganization(workspace, latest, operation)) {
        setReadError(
          operation === 'replace_tags'
            ? 'Tags can be replaced only on active workflows by an editor.'
            : 'Only owners and admins may move archived workflows.',
        );
        return;
      }
      await command.start(
        organizationEditAttempt(
          workspace.id,
          latest,
          operation,
          folderId,
          tagIds,
          crypto.randomUUID(),
        ),
      );
    } catch {
      if (alive.current)
        setReadError(
          'Current organization could not be checked. No new command was sent. Refresh before confirming again.',
        );
    } finally {
      preparingRef.current = false;
      if (alive.current) setPreparing(false);
    }
  }

  return {
    selected,
    selectionValid,
    command,
    current,
    folders,
    tags,
    reading,
    failedRead,
    locked,
    feedback,
    preparing,
    formEpoch,
    refresh,
    confirm,
  };
}

export function WorkflowOrganizationDialog(props: Props) {
  const editor = useOrganizationEdit(props);
  const { selected, selectionValid, command, reading, locked, feedback } =
    editor;
  const { workspace, onClose } = props;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>
          Organize{' '}
          {selected.length === 1
            ? 'workflow'
            : `${String(selected.length)} workflows`}
        </DialogTitle>
        <DialogDescription>
          Only these explicitly selected workflows are changed. Folder and tag
          changes do not publish, run or reorder workflows.
        </DialogDescription>
        <div className="mt-5 flex flex-col gap-5">
          {command.denied ? null : (
            <ul
              aria-label="Selected workflows"
              className="text-sm break-words text-muted-foreground"
            >
              {selected.map(({ workflow }) => (
                <li key={workflow.id}>{workflow.name}</li>
              ))}
            </ul>
          )}
          {!selectionValid ? (
            <Notice tone="destructive">
              Select 1–50 distinct workflows. No implicit selection of unloaded
              workflows is supported.
            </Notice>
          ) : null}
          {feedback === undefined ? null : (
            <Notice
              role="alert"
              tone={command.retryAvailable ? 'warning' : 'destructive'}
            >
              {feedback}
            </Notice>
          )}
          {command.denied || !reading ? null : (
            <Notice>Reading current organization…</Notice>
          )}
          <OrganizationEditForm editor={editor} workspace={workspace} />
          <OrganizationEditResult editor={editor} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {RECOVERY}
          </p>
          <OrganizationRecoveryActions editor={editor} onClose={onClose} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OrganizationEditForm({
  editor,
  workspace,
}: Readonly<{
  editor: ReturnType<typeof useOrganizationEdit>;
  workspace: AccessibleWorkspace;
}>) {
  const {
    command,
    selectionValid,
    current,
    selected,
    folders,
    tags,
    formEpoch,
    preparing,
    locked,
    reading,
    failedRead,
    confirm,
  } = editor;
  return (
    <>
      {command.denied ||
      !selectionValid ||
      current.length !== selected.length ||
      folders.data === undefined ||
      tags.data === undefined ? null : (
        <OrganizationFields
          key={formEpoch}
          workspace={workspace}
          workflows={current}
          folders={folders.data.items}
          tags={tags.data.pages.flatMap((page) => page.items)}
          pending={preparing || command.pending}
          locked={
            locked ||
            reading ||
            failedRead ||
            command.error !== undefined ||
            command.result !== undefined
          }
          onConfirm={confirm}
        />
      )}
    </>
  );
}

function OrganizationEditResult({
  editor,
}: Readonly<{ editor: ReturnType<typeof useOrganizationEdit> }>) {
  const { command, selected } = editor;
  return (
    <>
      {command.result === undefined ? null : 'items' in command.result ? (
        <WorkflowOrganizationOutcomes
          items={command.result.items.filter(
            (item) => item.status !== 'detached',
          )}
          workflows={command.denied ? [] : selected}
        />
      ) : (
        <Notice tone="success">
          Organization command accepted. Current metadata is refreshed
          separately.
        </Notice>
      )}
    </>
  );
}

function OrganizationRecoveryActions({
  editor,
  onClose,
}: Readonly<{
  editor: ReturnType<typeof useOrganizationEdit>;
  onClose: () => void;
}>) {
  const { command, tags, preparing, locked, refresh } = editor;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="ghost" disabled={locked} onClick={onClose}>
        Close
      </Button>
      {tags.hasNextPage && !command.denied ? (
        <ProgressButton
          variant="ghost"
          pending={tags.isFetchingNextPage}
          pendingLabel="Loading tags…"
          disabled={locked}
          onClick={() => {
            void tags.fetchNextPage();
          }}
        >
          Load more tags
        </ProgressButton>
      ) : null}
      {command.retryAvailable ? (
        <ProgressButton
          pending={command.pending}
          pendingLabel="Retrying…"
          disabled={preparing}
          onClick={() => {
            void command.retry();
          }}
        >
          Retry original request
        </ProgressButton>
      ) : null}
      {command.denied ? null : (
        <ProgressButton
          variant="outline"
          pending={preparing}
          pendingLabel="Refreshing…"
          disabled={command.pending}
          onClick={() => {
            void refresh();
          }}
        >
          {command.retryAvailable
            ? 'Refresh current state'
            : 'Refresh for a new change'}
        </ProgressButton>
      )}
    </div>
  );
}

function OrganizationFields({
  workspace,
  workflows,
  folders,
  tags,
  pending,
  locked,
  onConfirm,
}: Readonly<{
  workspace: AccessibleWorkspace;
  workflows: readonly WorkflowOrganizationProjectionResponse[];
  folders: readonly WorkflowFolder[];
  tags: readonly WorkflowTag[];
  pending: boolean;
  locked: boolean;
  onConfirm: (
    operation: OrganizationOperation,
    folderId: string | null,
    tagIds: readonly string[],
  ) => Promise<void>;
}>) {
  const id = useId();
  const [operation, setOperation] = useState<OrganizationOperation>('move');
  const [folderId, setFolderId] = useState<string | null>(() =>
    workflows.length === 1
      ? (workflows[0]?.organization.folderId ?? null)
      : null,
  );
  const [tagIds, setTagIds] = useState<readonly string[]>(() =>
    workflows.length === 1
      ? (workflows[0]?.organization.tags.map((tag) => tag.id) ?? [])
      : [],
  );
  const selectedTagIds = new Set(tagIds);
  const validation = useFieldValidation<'tags'>();
  const allowed = canEditOrganization(workspace, workflows, operation);
  const visibleTags = [
    ...new Map(
      [
        ...workflows.flatMap(({ organization }) => organization.tags),
        ...tags,
      ].map((tag) => [tag.id, tag]),
    ).values(),
  ];
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (locked || !allowed) return;
        if (
          !validation.submit({
            tags: tagIds.length > 16 ? 'Select at most 16 tags.' : undefined,
          })
        )
          return;
        void onConfirm(operation, folderId, tagIds);
      }}
    >
      <FieldGroup>
        <LabelledField id={`${id}-operation`} label="Change">
          {(control) => (
            <ToggleGroup
              {...control}
              aria-label="Change"
              value={[operation]}
              onValueChange={(values) => {
                const next = values[0];
                if (next === 'move' || next === 'replace_tags')
                  setOperation(next);
              }}
              disabled={locked}
            >
              <ToggleGroupItem value="move">Move to folder</ToggleGroupItem>
              <ToggleGroupItem value="replace_tags">
                Replace tags
              </ToggleGroupItem>
            </ToggleGroup>
          )}
        </LabelledField>
        {operation === 'move' ? (
          <WorkflowFolderPicker
            folders={folders}
            value={folderId}
            onChange={setFolderId}
            disabled={locked || !allowed}
          />
        ) : (
          <fieldset
            disabled={locked || !allowed}
            className="flex flex-col gap-2"
          >
            <legend className="text-sm font-medium">Replacement tags</legend>
            <p className="text-xs text-muted-foreground">
              This replaces all current tags on each selected workflow. Select
              none to clear them. Maximum 16.
            </p>
            {visibleTags.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No workspace tags are available.
              </p>
            ) : (
              visibleTags.map((tag) => (
                <label
                  key={tag.id}
                  className="flex min-w-0 items-center gap-2 text-sm break-words [content-visibility:auto]"
                >
                  <Checkbox
                    checked={selectedTagIds.has(tag.id)}
                    disabled={
                      locked ||
                      !allowed ||
                      (!selectedTagIds.has(tag.id) && tagIds.length >= 16)
                    }
                    onCheckedChange={(checked) => {
                      setTagIds((current) =>
                        checked
                          ? [...current, tag.id].sort()
                          : current.filter((id) => id !== tag.id),
                      );
                    }}
                  />
                  {tag.key}
                </label>
              ))
            )}
            {validation.error('tags') === undefined ? null : (
              <Notice tone="destructive">{validation.error('tags')}</Notice>
            )}
          </fieldset>
        )}
        {!allowed ? (
          <Notice>
            {operation === 'replace_tags'
              ? 'Tag replacement requires an editor and active workflows. Archived tags are detached only through admin cleanup.'
              : 'Moving active workflows requires an editor. Only owners and admins may move archived workflows.'}
          </Notice>
        ) : null}
        <ProgressButton
          type="submit"
          pending={pending}
          pendingLabel="Confirming…"
          disabled={locked || !allowed}
        >
          {operation === 'move'
            ? 'Move selected workflows'
            : 'Replace selected tags'}
        </ProgressButton>
      </FieldGroup>
    </form>
  );
}
