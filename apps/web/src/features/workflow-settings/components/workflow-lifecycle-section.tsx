import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ApiClient } from '@/lib/api/client';
import type { WorkflowSettingsSummary } from '../workflow-settings.api';
import { useWorkflowLifecycleCommand } from '../mutations/use-workflow-settings-commands';
import {
  SettingsQueryState,
  SettingsSection,
  type SettingsQuery,
} from './settings-section';
import { visibleSettingsData } from './settings-query';

type LifecycleIntent = Readonly<{
  command: 'archive' | 'restore';
  expectedLifecycleRevision: number;
}>;

export function WorkflowLifecycleSection({
  apiClient,
  userId,
  workspace,
  workflowId,
  query,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  query: SettingsQuery<WorkflowSettingsSummary>;
}>) {
  const workflow = visibleSettingsData(query);

  return (
    <SettingsSection
      title="Lifecycle"
      description="Archive or restore using the latest server-owned lifecycle revision."
    >
      <SettingsQueryState query={query} />
      {!query.isPending && !query.isError && workflow === null ? (
        <p className="text-sm text-muted-foreground">
          The workflow was not found in the bounded workspace listing.
        </p>
      ) : null}
      {workflow ? (
        <WorkflowLifecycleContent
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflowId={workflowId}
          workflow={workflow}
        />
      ) : null}
    </SettingsSection>
  );
}

function WorkflowLifecycleContent({
  apiClient,
  userId,
  workspace,
  workflowId,
  workflow,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  workflow: Exclude<WorkflowSettingsSummary, null>;
}>) {
  const [intent, setIntent] = useState<LifecycleIntent>();
  const command =
    workflow.lifecycleStatus === 'archived' ? 'restore' : 'archive';
  const canManage = workspace.capabilities.includes('workflow:publish');
  const lifecycle = useWorkflowLifecycleCommand({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  });

  async function submit() {
    if (!intent) return;
    if (
      await lifecycle.submit(intent.command, intent.expectedLifecycleRevision)
    )
      setIntent(undefined);
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-medium">{workflow.name}</p>
          <Badge variant="muted" className="mt-2">
            {workflow.lifecycleStatus}
          </Badge>
        </div>
        {canManage ? (
          <Button
            type="button"
            variant={command === 'archive' ? 'destructive' : 'outline'}
            onClick={() => {
              lifecycle.reset();
              setIntent({
                command,
                expectedLifecycleRevision: workflow.lifecycleRevision,
              });
            }}
          >
            {command === 'archive' ? 'Archive workflow' : 'Restore workflow'}
          </Button>
        ) : null}
      </div>
      <Dialog
        open={intent !== undefined}
        onOpenChange={(open) => {
          if (!open && !lifecycle.pending) {
            lifecycle.reset();
            setIntent(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>
            {intent?.command === 'archive'
              ? 'Archive workflow?'
              : 'Restore workflow?'}
          </DialogTitle>
          <DialogDescription>
            This command is conditional on lifecycle revision{' '}
            {String(intent?.expectedLifecycleRevision ?? '')} and will fail
            safely if another actor changed it.
          </DialogDescription>
          {lifecycle.error ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {lifecycle.error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  disabled={lifecycle.pending}
                />
              }
            >
              Cancel
            </DialogClose>
            <Button
              type="button"
              variant={
                intent?.command === 'archive' ? 'destructive' : 'default'
              }
              disabled={lifecycle.pending}
              onClick={() => void submit()}
            >
              {lifecycle.pending
                ? 'Submitting…'
                : lifecycle.error
                  ? 'Retry safely'
                  : intent?.command === 'archive'
                    ? 'Archive'
                    : 'Restore'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
