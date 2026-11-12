import { useOrganizationReadLifetime } from '../../../hooks/organization/use-organization-read-lifetime';
import { isAdministrativeRole } from '@pertexo/policy';
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace, WorkflowTag } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { ActionDialog } from '@/components/patterns/actions/dialog';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { QueryView } from '@/components/patterns/states/query-view';
import { workflowTagsInfiniteQueryOptions } from '../../../data/organization/workflow-organization.queries';
import type { WorkflowOrganizationInput } from '../../../model/organization/requests';
import { useWorkflowOrganizationCommand } from '../../../hooks/organization/use-workflow-organization-command';
import { TagManagement } from './management';
import { WorkflowTagCleanup } from './cleanup';
import { ADMINISTRATORS } from '@/features/workspaces/roles.public';
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
        description={`Only ${ADMINISTRATORS} in an active workspace can manage tags.`}
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
  const lifetime = useOrganizationReadLifetime(userId, workspace.id);
  const readDenied = lifetime.error !== undefined;
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
    useState<WorkflowOrganizationInput['kind']>();
  const locked = command.pending || command.denied || readDenied;
  const start = (attempt: WorkflowOrganizationInput) => {
    if (locked) return;
    setPendingKind(attempt.kind);
    void command.start(attempt);
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
      {command.denied || readDenied ? (
        <Notice tone="warning">
          Your access changed, so tags can’t be edited here. Close this and
          check your role in the workspace.
        </Notice>
      ) : null}

      <QueryView query={tags} resource="Tags" loading={null} />
      {!command.denied && !readDenied && cleanup === undefined ? (
        <>
          <TagManagement
            tags={items}
            ready={tags.isSuccess && !tags.isFetching}
            locked={locked}
            scope={{ workspaceId: workspace.id }}
            command={command}
            pendingKind={pendingKind}
            actions={{
              start,
              onReload: () => void tags.refetch(),
              onCleanup: (tag) => {
                command.reset();
                setCleanup(tag);
              },
            }}
          />
          <LoadMore
            subject="tags"
            hasNextPage={tags.hasNextPage}
            loading={tags.isFetchingNextPage || locked}
            failed={tags.isFetchNextPageError}
            error={tags.error}
            label="Show more tags"
            onLoadMore={() => {
              if (!locked) void tags.fetchNextPage();
            }}
          />
        </>
      ) : null}
      {!command.denied && !readDenied && cleanup !== undefined ? (
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
