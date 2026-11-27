import { useWorkflowSettingsRefresh } from '../../data/mutations/use-settings-refresh';
import { useState } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { ArchiveIcon, ArchiveRestoreIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  LIFECYCLE_CONSEQUENCES,
  lifecycleIntentFor,
  type LifecycleIntent,
} from '@/features/workflows/public';
import { WorkflowLifecycleDialog } from '@/features/workflows/workflows-views.public';
import type { ApiClient } from '@/lib/api/client';
import {
  QueryView,
  type ReadQuery,
} from '@/components/patterns/states/query-view';
import { SettingRow, SettingsGroup } from '@/components/patterns/settings/row';
import { settingsReadFailure } from '../settings-read-failure';
import { roleLimitSentence } from '@/features/workspaces/public';
import { shownData } from '@/lib/api/error-copy';

/** What archiving or restoring does, then the button, as one row. */
function LifecycleRow({
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
  return (
    <SettingRow
      title={archived ? 'Restore workflow' : 'Archive workflow'}
      description={
        <>
          {LIFECYCLE_CONSEQUENCES[archived ? 'restore' : 'archive'].join(' ')}
          {canManage ? null : (
            <span id="lifecycle-permission" className="mt-1 block">
              {roleLimitSentence(
                role,
                'workflow:publish',
                'archive or restore workflows',
              )}
            </span>
          )}
        </>
      }
      action={
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
      }
    />
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
  query: ReadQuery<WorkflowSummary>;
}>) {
  const refreshSettings = useWorkflowSettingsRefresh(
    userId,
    workspace.id,
    workflowId,
  );
  const [intent, setIntent] = useState<LifecycleIntent>();
  const workflow = shownData(query);
  const canManage = workspace.capabilities.includes('workflow:publish');

  return (
    <SettingsGroup title="Danger zone">
      <QueryView
        query={query}
        resource="This workflow"
        failure={settingsReadFailure}
      >
        {(shown) => (
          <LifecycleRow
            workflow={shown}
            role={workspace.role}
            canManage={canManage}
            onStart={() => {
              setIntent(lifecycleIntentFor(shown));
            }}
          />
        )}
      </QueryView>
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
        onCompleted={refreshSettings}
        onClose={() => {
          setIntent(undefined);
        }}
      />
    </SettingsGroup>
  );
}
