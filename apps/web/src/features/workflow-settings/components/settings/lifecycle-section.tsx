import { useState } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveIcon, ArchiveRestoreIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { describeWorkflowState } from '@/features/workflows/hub.public';
import {
  LIFECYCLE_CONSEQUENCES,
  WorkflowLifecycleDialog,
  lifecycleIntentFor,
  type LifecycleIntent,
} from '@/features/workflows/lifecycle.public';
import type { ApiClient } from '@/lib/api/client';
import { workflowSettingsKeys } from '../../workflow-settings.queries';
import {
  visibleSettingsData,
  type SettingsQuery,
} from '../../model/settings-query';
import { SettingsQueryState, SettingsSection } from '../settings-section';
import { roleLimitSentence } from '@/features/workspaces/roles.public';

/** Where the workflow is now, what archiving or restoring does, and the button. */
function LifecycleCard({
  workflow,
  role,
  canManage,
  onStart,
}: Readonly<{
  workflow: WorkflowSummary;
  role: AccessibleWorkspace['role'];
  canManage: boolean;
  onStart: () => void;
}>) {
  const archived = workflow.lifecycleStatus === 'archived';
  const state = describeWorkflowState(workflow);
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Now</span>
        <Status tone={state.tone}>{state.label}</Status>
      </div>
      <p className="text-sm font-medium">
        {archived ? 'If you restore it:' : 'If you archive it:'}
      </p>
      <ul className="-mt-2 flex flex-col gap-1.5 text-sm text-muted-foreground">
        {LIFECYCLE_CONSEQUENCES[archived ? 'restore' : 'archive'].map(
          (line) => (
            <li key={line}>{line}</li>
          ),
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant={archived ? 'default' : 'destructive'}
          disabled={!canManage}
          aria-describedby={canManage ? undefined : 'lifecycle-permission'}
          onClick={onStart}
        >
          {archived ? (
            <ArchiveRestoreIcon aria-hidden="true" data-icon="inline-start" />
          ) : (
            <ArchiveIcon aria-hidden="true" data-icon="inline-start" />
          )}
          {archived ? 'Restore workflow' : 'Archive workflow'}
        </Button>
        {canManage ? null : (
          <p
            id="lifecycle-permission"
            className="text-xs text-subtle-foreground"
          >
            {roleLimitSentence(
              role,
              'workflow:publish',
              'archive or restore workflows',
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Archive or restore, with what each does spelled out. People who can't
 * publish see the button disabled and why.
 */
export function LifecycleSection({
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
  query: SettingsQuery<WorkflowSummary>;
}>) {
  const queryClient = useQueryClient();
  const [intent, setIntent] = useState<LifecycleIntent>();
  const workflow = visibleSettingsData(query);
  const canManage = workspace.capabilities.includes('workflow:publish');

  return (
    <SettingsSection
      title="Lifecycle"
      description="Archive a workflow you no longer need. Nothing is deleted."
    >
      <SettingsQueryState query={query} resource="This workflow" />
      {workflow === undefined ? null : (
        <LifecycleCard
          workflow={workflow}
          role={workspace.role}
          canManage={canManage}
          onStart={() => {
            setIntent(lifecycleIntentFor(workflow));
          }}
        />
      )}
      <WorkflowLifecycleDialog
        key={
          intent === undefined
            ? 'closed'
            : `${intent.command}:${String(intent.expectedLifecycleRevision)}`
        }
        apiClient={apiClient}
        userId={userId}
        workspaceId={workspace.id}
        workflowId={workflowId}
        workflowName={workflow?.name ?? ''}
        intent={workflow === undefined ? undefined : intent}
        onCompleted={() =>
          void queryClient.invalidateQueries({
            queryKey: workflowSettingsKeys.root(
              userId,
              workspace.id,
              workflowId,
            ),
          })
        }
        onClose={() => {
          setIntent(undefined);
        }}
      />
    </SettingsSection>
  );
}
