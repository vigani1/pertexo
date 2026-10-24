import { isAdministrativeRole } from '@pertexo/workflow-model';
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace, WorkflowTag } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { ActionDialog } from '@/components/patterns/actions/action-dialog';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { QueryView } from '@/components/patterns/states/query-view';
import { workflowTagsInfiniteQueryOptions } from '../../../data/organization/queries';
import {
  freezeWorkflowOrganizationAttempt,
  type WorkflowOrganizationAttempt,
} from '../../../model/organization/requests';
import { useWorkflowOrganizationCommand } from '../../../hooks/use-workflow-organization-command';
import { TagManagement } from './management';
import { WorkflowTagCleanup } from './cleanup';

type Props = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  onClose: () => void;
}>;

/** Owners and admins add, rename and remove the workspace's tags here. */
export function WorkflowTagsDialog(props: Props) {
  if (
    props.workspace.status !== 'active' ||
    !isAdministrativeRole(props.workspace.role)
  )
    return (
      <ActionDialog
        title="Tags"
        description="Only owners and admins in an active workspace can manage tags."
        locked={false}
        onClose={props.onClose}
        footer={
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Done
          </Button>
        }
      >
        {null}
      </ActionDialog>
    );
  return (
    <TagsDialogContent
      key={`${props.userId}:${props.workspace.id}`}
      {...props}
    />
  );
}

function TagsDialogContent({ apiClient, userId, workspace, onClose }: Props) {
  const tags = useInfiniteQuery(
    workflowTagsInfiniteQueryOptions(apiClient, userId, workspace.id),
  );
  const command = useWorkflowOrganizationCommand({
    apiClient,
    userId,
    workspace,
    requiredRole: 'admin',
  });
  const [cleanup, setCleanup] = useState<WorkflowTag>();
  const [pendingKind, setPendingKind] =
    useState<WorkflowOrganizationAttempt['kind']>();
  const [invalid, setInvalid] = useState(false);
  const locked = command.pending || command.retryAvailable || command.denied;
  const start = (attempt: WorkflowOrganizationAttempt) => {
    if (locked) return;
    try {
      const frozen = freezeWorkflowOrganizationAttempt(attempt);
      setInvalid(false);
      setPendingKind(frozen.kind);
      void command.start(frozen);
    } catch {
      setInvalid(true);
    }
  };
  const items = tags.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <ActionDialog
      className="max-w-xl"
      title={
        cleanup === undefined ? 'Tags' : `Workflows tagged #${cleanup.key}`
      }
      description={
        cleanup === undefined
          ? 'Tags help people find workflows. They never change who can open or run them.'
          : 'Remove the tag from the workflows you choose.'
      }
      locked={command.pending}
      onClose={onClose}
      footer={
        <Button
          type="button"
          variant="ghost"
          disabled={command.pending}
          onClick={onClose}
        >
          Done
        </Button>
      }
    >
      {command.denied ? (
        <Notice tone="warning">
          Your access changed, so tags can’t be edited here. Close this and
          check your role in the workspace.
        </Notice>
      ) : null}
      {invalid ? (
        <Notice tone="destructive">
          Check the tag. Use lowercase letters, numbers and hyphens, up to 32
          characters.
        </Notice>
      ) : null}
      <QueryView query={tags} resource="Tags" loading={null} />
      {!command.denied && cleanup === undefined ? (
        <>
          <TagManagement
            tags={items}
            ready={tags.isSuccess && !tags.isFetching}
            locked={locked}
            scope={{ workspaceId: workspace.id }}
            start={start}
            command={command}
            pendingKind={pendingKind}
            onReload={() => void tags.refetch()}
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
            label="Show more tags"
            onLoadMore={() => {
              if (!locked) void tags.fetchNextPage();
            }}
          />
        </>
      ) : null}
      {!command.denied && cleanup !== undefined ? (
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
      ) : null}
    </ActionDialog>
  );
}
