import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { WorkflowAutoPauseSettings } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { SettingSentence } from '@/components/patterns/settings/sentence';
import { SettingRow } from '@/components/patterns/settings/row';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import { workflowAutoPauseQueryOptions } from '../../data/auto-pause.queries';
import { useAutoPauseCommand } from '../../data/mutations/use-auto-pause-command';
import { QueryView } from '@/components/patterns/states/query-view';
import { settingsReadFailure } from '../settings-read-failure';
import { type Scope, CommandProblem } from './auto-pause-fields';
import { thresholdError } from '../../model/auto-pause-input';
import { WorkspaceDefault } from './workspace-default';
import { whoCan } from '@/features/workspaces/public';
function WorkflowRule({
  settings,
  scope,
  onSaved,
}: Readonly<{
  settings: WorkflowAutoPauseSettings;
  scope: Scope;
  onSaved: () => void;
}>) {
  const [draft, setDraft] = useState<
    Readonly<{
      enabled: boolean;
      threshold: string;
      revision: number;
    }>
  >();
  const current = draft ?? {
    enabled: settings.enabled,
    threshold:
      settings.thresholdOverride === null
        ? ''
        : String(settings.thresholdOverride),
    revision: settings.settingsRevision,
  };
  const validation = useFieldValidation<'threshold'>();
  const command = useAutoPauseCommand(
    scope.apiClient,
    scope.userId,
    scope.workspace.id,
    scope.workflowId,
  );
  const notifications = useNotifications();
  async function save() {
    if (
      !validation.submit({
        threshold: thresholdError({ value: current.threshold, optional: true }),
      })
    )
      return;
    const saved = await command.send({
      kind: 'workflow',
      body: {
        enabled: current.enabled,
        thresholdOverride:
          current.threshold.trim() === '' ? null : Number(current.threshold),
        expectedSettingsRevision:
          command.problem !== undefined
            ? settings.settingsRevision
            : current.revision,
      },
    });
    if (saved) {
      setDraft(undefined);
      notifications.success({ title: 'Auto-pause settings saved' });
      onSaved();
    }
  }
  return (
    <form
      className="flex max-w-lg flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <LabelledField
        id="workflow-auto-pause-enabled"
        label="Auto-pause for this workflow"
        description={
          current.enabled
            ? 'Triggered runs pause after repeated failures.'
            : 'Repeated failures won’t pause this workflow.'
        }
      >
        {(control) => (
          <Switch
            {...control}
            name="autoPauseEnabled"
            checked={current.enabled}
            disabled={command.pending}
            onCheckedChange={(enabled) => {
              setDraft({ ...current, enabled });
            }}
          />
        )}
      </LabelledField>
      <LabelledField
        id="workflow-auto-pause-threshold"
        label="Pause after failures in a row"
        description={`Leave blank for the workspace default, ${String(settings.workspaceThreshold)}.`}
        error={validation.error('threshold')}
      >
        {(control) => (
          <Input
            {...control}
            name="thresholdOverride"
            autoComplete="off"
            ref={validation.register('threshold')}
            inputMode="numeric"
            value={current.threshold}
            placeholder={`Workspace default: ${String(settings.workspaceThreshold)}`}
            disabled={command.pending}
            onChange={(event) => {
              setDraft({ ...current, threshold: event.target.value });
              validation.change(
                'threshold',
                thresholdError({ value: event.target.value, optional: true }),
              );
            }}
          />
        )}
      </LabelledField>
      <div>
        <ProgressButton
          type="submit"
          pending={command.pending}
          pendingLabel="Saving…"
          disabled={false}
        >
          Save auto-pause rule
        </ProgressButton>
      </div>
      <CommandProblem command={command} />
    </form>
  );
}
/** The workflow's rule in words. */
function ruleSummary(settings: WorkflowAutoPauseSettings) {
  if (!settings.enabled)
    return (
      <>
        <b>Off.</b> Repeated failures won’t pause this workflow.
      </>
    );
  return (
    <>
      Triggers <b>pause after {settings.effectiveThreshold}</b> failures in a
      row
      {settings.thresholdOverride === null ? ', the workspace default.' : '.'}
    </>
  );
}
export function AutoPauseSection(scope: Scope) {
  const [editing, setEditing] = useState(false);
  const query = useQuery(
    workflowAutoPauseQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
      scope.workflowId,
    ),
  );
  const canManageWorkspace =
    scope.workspace.capabilities.includes('workspace:manage');
  const canUpdate = scope.workspace.capabilities.includes('workflow:update');
  return (
    <SettingRow
      title="Automatic pause"
      description="When repeated failures should pause workflow triggers."
    >
      <QueryView
        query={query}
        resource="The auto-pause rule"
        failure={settingsReadFailure}
      >
        {(settings) => (
          <>
            <SettingSentence
              summary={
                <>
                  {ruleSummary(settings)}
                  {canUpdate ? null : ' Your role can’t change this rule.'}
                </>
              }
              editing={editing}
              onEditingChange={setEditing}
              {...(canUpdate
                ? {
                    editor: (
                      <WorkflowRule
                        settings={settings}
                        scope={scope}
                        onSaved={() => {
                          setEditing(false);
                        }}
                      />
                    ),
                  }
                : {})}
              rules={
                <>
                  <p>
                    Runs already going finish, and manual runs and replays still
                    work while triggers are paused.
                  </p>
                  <p>
                    HTTP Polling also pauses after repeated failed checks.
                    Confirmed authentication loss pauses triggers immediately.
                  </p>
                  <p>
                    A change applies from the next failure, without publishing.
                    It never resumes a workflow that has already paused.
                  </p>
                </>
              }
            />
            {settings.pauseEvidence?.kind !== 'poll' ? null : (
              <Link
                to="/w/$workspaceId/workflows/$workflowId/triggers"
                params={{
                  workspaceId: scope.workspace.id,
                  workflowId: scope.workflowId,
                }}
                hash={settings.pauseEvidence.triggerId}
                className="inline-link text-sm"
              >
                Polling trigger that caused the pause
              </Link>
            )}
            {canManageWorkspace ? null : (
              <p className="text-sm text-muted-foreground">
                Workspace default: {String(settings.workspaceThreshold)}{' '}
                failures in a row. Only workspace {whoCan('workspace:manage')}{' '}
                can change it.
              </p>
            )}
          </>
        )}
      </QueryView>
      {canManageWorkspace ? <WorkspaceDefault scope={scope} /> : null}
    </SettingRow>
  );
}
