import { useState } from 'react';
import type {
  AccessibleWorkspace,
  WorkflowAutoPauseSettings,
  WorkspaceAutoPauseSettings,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { SettingSentence } from '@/components/patterns/settings/sentence';
import { SettingsSection } from '@/components/patterns/settings/section';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  workflowAutoPauseQueryOptions,
  workspaceAutoPauseQueryOptions,
} from '../../data/auto-pause.queries';
import { useAutoPauseCommand } from '../../data/mutations/use-auto-pause-command';
import { QueryView } from '@/components/patterns/states/query-view';
import { settingsReadFailure } from '../settings-read-failure';

type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;

function thresholdError({
  value,
  optional = false,
}: Readonly<{ value: string; optional?: boolean | undefined }>):
  string | undefined {
  if (optional && value.trim() === '') return undefined;
  return /^\d+$/u.test(value) && Number(value) >= 3 && Number(value) <= 100
    ? undefined
    : 'Enter a whole number from 3 to 100.';
}

function CommandProblem({
  command,
  onRetrySuccess,
}: Readonly<{
  command: ReturnType<typeof useAutoPauseCommand>;
  onRetrySuccess: () => void;
}>) {
  if (command.problem === undefined) return null;
  return (
    <Notice
      tone={command.unconfirmed ? 'warning' : 'destructive'}
      action={
        command.unconfirmed ? (
          <ProgressButton
            type="button"
            variant="outline"
            pending={command.pending}
            pendingLabel="Retrying…"
            onClick={() => {
              void command.retry().then((saved) => {
                if (saved) onRetrySuccess();
              });
            }}
          >
            Retry same change
          </ProgressButton>
        ) : undefined
      }
    >
      {command.problem}
    </Notice>
  );
}

function WorkflowRule({
  settings,
  scope,
  onSaved,
}: Readonly<{
  settings: WorkflowAutoPauseSettings;
  scope: Scope;
  onSaved: () => void;
}>) {
  const [draft, setDraft] =
    useState<
      Readonly<{ enabled: boolean; threshold: string; revision: number }>
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
        expectedSettingsRevision: command.conflict
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
            ? 'Schedules and webhooks pause after repeated failures.'
            : 'This workflow keeps starting runs however often it fails.'
        }
      >
        {(control) => (
          <Switch
            {...control}
            name="autoPauseEnabled"
            checked={current.enabled}
            disabled={command.pending || command.unconfirmed}
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
            disabled={command.pending || command.unconfirmed}
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
          disabled={command.unconfirmed}
        >
          Save auto-pause rule
        </ProgressButton>
      </div>
      <CommandProblem
        command={command}
        onRetrySuccess={() => {
          setDraft(undefined);
          notifications.success({ title: 'Auto-pause settings saved' });
          onSaved();
        }}
      />
    </form>
  );
}

function WorkspaceDefaultForm({
  settings,
  scope,
  onSaved,
}: Readonly<{
  settings: WorkspaceAutoPauseSettings;
  scope: Scope;
  onSaved: () => void;
}>) {
  const [draft, setDraft] =
    useState<Readonly<{ threshold: string; revision: number }>>();
  const current = draft ?? {
    threshold: String(settings.threshold),
    revision: settings.revision,
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
        threshold: thresholdError({ value: current.threshold }),
      })
    )
      return;
    if (
      await command.send({
        kind: 'workspace',
        body: {
          threshold: Number(current.threshold),
          expectedRevision: command.conflict
            ? settings.revision
            : current.revision,
        },
      })
    ) {
      setDraft(undefined);
      notifications.success({ title: 'Workspace auto-pause default saved' });
      onSaved();
    }
  }
  return (
    <form
      className="flex max-w-lg flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <LabelledField
        id="workspace-auto-pause-threshold"
        label="Workspace default"
        description="For every workflow without its own number. Enter 3 to 100."
        error={validation.error('threshold')}
      >
        {(control) => (
          <Input
            {...control}
            name="workspaceAutoPauseThreshold"
            autoComplete="off"
            ref={validation.register('threshold')}
            inputMode="numeric"
            value={current.threshold}
            disabled={command.pending || command.unconfirmed}
            onChange={(event) => {
              setDraft({ ...current, threshold: event.target.value });
              validation.change(
                'threshold',
                thresholdError({ value: event.target.value }),
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
          disabled={command.unconfirmed}
        >
          Save workspace default
        </ProgressButton>
      </div>
      <CommandProblem
        command={command}
        onRetrySuccess={() => {
          setDraft(undefined);
          notifications.success({
            title: 'Workspace auto-pause default saved',
          });
          onSaved();
        }}
      />
    </form>
  );
}

function WorkspaceDefault({ scope }: Readonly<{ scope: Scope }>) {
  const [editing, setEditing] = useState(false);
  const query = useQuery(
    workspaceAutoPauseQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
    ),
  );
  return (
    <QueryView
      query={query}
      resource="The workspace auto-pause default"
      failure={settingsReadFailure}
    >
      {(settings) => (
        <SettingSentence
          summary={
            <>
              Across the workspace, a workflow without its own number pauses
              after <b>{settings.threshold} failures in a row</b>.
            </>
          }
          editing={editing}
          onEditingChange={setEditing}
          editor={
            <WorkspaceDefaultForm
              settings={settings}
              scope={scope}
              onSaved={() => {
                setEditing(false);
              }}
            />
          }
        />
      )}
    </QueryView>
  );
}

/** The workflow's rule in words. */
function ruleSummary(settings: WorkflowAutoPauseSettings) {
  if (!settings.enabled)
    return (
      <>
        <b>Off.</b> This workflow keeps starting runs however often it fails.
      </>
    );
  return (
    <>
      Schedules and webhooks <b>pause after {settings.effectiveThreshold}</b>{' '}
      failures in a row
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
    <SettingsSection
      title="Automatic pause"
      description="When repeated failures should stop scheduled and webhook runs."
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
                    A change applies from the next failure, without publishing.
                    It never resumes a workflow that has already paused.
                  </p>
                </>
              }
            />
            {canManageWorkspace ? null : (
              <p className="text-sm text-muted-foreground">
                Workspace default: {String(settings.workspaceThreshold)}{' '}
                failures in a row. Only workspace owners can change it.
              </p>
            )}
          </>
        )}
      </QueryView>
      {canManageWorkspace ? <WorkspaceDefault scope={scope} /> : null}
    </SettingsSection>
  );
}
