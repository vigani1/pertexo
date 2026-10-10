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
import { LoadMore } from '@/components/patterns/load-more';
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
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [pendingKind, setPendingKind] =
    useState<WorkflowOrganizationAttempt['kind']>();
  const locked = command.pending || command.retryAvailable || command.denied;
  const start: StartCommand = (attempt) => {
    if (locked) return;
    try {
      const frozen = freezeWorkflowOrganizationAttempt(attempt);
      setValidation(undefined);
      setPendingKind(frozen.kind);
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
                command={command}
                pendingKind={pendingKind}
                onConfirmationChange={setConfirmationOpen}
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
