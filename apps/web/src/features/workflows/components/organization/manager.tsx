import { useFolderSharingEditor } from '../../hooks/use-folder-sharing';
import { FolderSharingPanel } from './folders/sharing';
import { useAudienceMove } from '../../hooks/use-audience-move';
import { AudienceMoveReview } from './folders/audience-review';
import { FolderManagement } from './folders/management';
import { TagManagement } from './tags/management';
import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace, WorkflowTag } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Separator } from '@/components/ui/separator';
import { LoadMore } from '@/components/patterns/lists/load-more';
import {
  workflowFoldersQueryOptions,
  workflowTagsInfiniteQueryOptions,
} from '../../data/organization/queries';
import {
  freezeWorkflowOrganizationAttempt,
  type WorkflowOrganizationAttempt,
} from '../../model/organization/requests';
import { useWorkflowOrganizationCommand } from '../../hooks/use-workflow-organization-command';
import { OrganizationCommandFeedback } from './command-feedback';
import { WorkflowTagCleanup } from './tags/cleanup';

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

function useOrganizationManager({
  apiClient,
  userId,
  workspace,
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
  const [sharingFolderId, setSharingFolderId] = useState<string>();
  const sharing = useFolderSharingEditor(
    { apiClient, userId, workspaceId: workspace.id },
    sharingFolderId,
  );
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [pendingKind, setPendingKind] =
    useState<WorkflowOrganizationAttempt['kind']>();
  const audience = useAudienceMove(apiClient, workspace.id, (attempt) =>
    command.start(attempt),
  );
  const locked =
    command.pending ||
    command.retryAvailable ||
    command.denied ||
    sharing.closeLocked ||
    audience.pending ||
    audience.review !== undefined;
  const start: StartCommand = (attempt) => {
    if (locked) return;
    try {
      const frozen = freezeWorkflowOrganizationAttempt(attempt);
      setValidation(undefined);
      setPendingKind(frozen.kind);
      void audience.begin(frozen);
    } catch {
      setValidation(
        'Check the name, destination and selection. Names must fit their limits; folder names cannot contain control characters.',
      );
    }
  };
  const scope = { workspaceId: workspace.id };
  return {
    folders,
    tags,
    command,
    validation,
    setValidation,
    cleanup,
    setCleanup,
    confirmationOpen,
    setConfirmationOpen,
    pendingKind,
    locked,
    start,
    scope,
    audience,
    sharing,
    sharingFolderId,
    changeSharing: (folderId: string | undefined) => {
      if (!sharing.closeLocked) {
        sharing.discard();
        setSharingFolderId(folderId);
      }
    },
    closeLocked:
      command.pending ||
      command.retryAvailable ||
      sharing.closeLocked ||
      audience.pending,
  };
}

function OrganizationManagerContent(props: ManagerProps) {
  const manager = useOrganizationManager(props);
  const {
    folders,
    tags,
    command,
    validation,
    setValidation,
    cleanup,
    confirmationOpen,
    locked,
  } = manager;
  const { onClose } = props;
  const { closeLocked } = manager;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !closeLocked) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogTitle>Manage workflow organization</DialogTitle>
        <DialogDescription>
          Organize workflows and review folder sharing. Tags never change access
          or execution.
        </DialogDescription>
        <div className="mt-6 flex flex-col gap-6">
          {!command.denied &&
          (cleanup !== undefined || confirmationOpen) ? null : (
            <OrganizationCommandFeedback command={command} />
          )}
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
          <ManagerAudienceReview manager={manager} />
          <OrganizationManagerControls manager={manager} {...props} />
          <Button
            type="button"
            variant="outline"
            disabled={closeLocked}
            onClick={onClose}
          >
            Close manager
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OrganizationManagerControls({
  manager,
  apiClient,
  userId,
  workspace,
}: ManagerProps &
  Readonly<{ manager: ReturnType<typeof useOrganizationManager> }>) {
  const {
    folders,
    tags,
    command,
    cleanup,
    setCleanup,
    locked,
    scope,
    start,
    pendingKind,
    setConfirmationOpen,
  } = manager;
  return (
    <>
      {command.denied ? (
        <Notice tone="warning">
          Organization controls are closed because access changed. Reopen the
          manager only after checking current access.
        </Notice>
      ) : cleanup === undefined ? (
        <>
          <FolderManagement
            folders={folders.data?.items ?? []}
            ready={folders.isSuccess && !folders.isFetching}
            locked={locked}
            scope={scope}
            start={start}
            command={command}
            pendingKind={pendingKind}
            onConfirmationChange={setConfirmationOpen}
            sharingFolderId={manager.sharingFolderId}
            onSharingChange={manager.changeSharing}
            sharing={
              <FolderSharingPanel
                scope={{ apiClient, userId, workspaceId: workspace.id }}
                name={
                  folders.data?.items.find(
                    (folder) => folder.id === manager.sharingFolderId,
                  )?.name ?? 'Folder'
                }
                editor={manager.sharing}
              />
            }
          />
          <Separator />
          <TagManagement
            tags={tags.data?.pages.flatMap((page) => page.items) ?? []}
            ready={tags.isSuccess && !tags.isFetching}
            locked={locked}
            scope={scope}
            start={start}
            command={command}
            pendingKind={pendingKind}
            onConfirmationChange={setConfirmationOpen}
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
    </>
  );
}

function ManagerAudienceReview({
  manager,
}: Readonly<{ manager: ReturnType<typeof useOrganizationManager> }>) {
  const { audience, command } = manager;
  return (
    <>
      {audience.error ? <Notice tone="warning">{audience.error}</Notice> : null}
      {audience.review ? (
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
      ) : null}
    </>
  );
}
