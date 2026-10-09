import { useState } from 'react';
import type {
  AccessibleWorkspace,
  WorkflowAutoPauseSettings,
  WorkspaceAutoPauseSettings,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { SettingsSection } from '@/components/patterns/settings-section';
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
} from '../../auto-pause.queries';
import { useAutoPauseCommand } from '../../mutations/use-auto-pause-command';
import { visibleSettingsData } from '../../model/settings-query';
import { SettingsQueryState } from '../settings-query-state';

type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;

function thresholdError(value: string, optional = false): string | undefined {
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
}: Readonly<{ settings: WorkflowAutoPauseSettings; scope: Scope }>) {
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
  const canUpdate = scope.workspace.capabilities.includes('workflow:update');
  async function save() {
    if (
      !validation.submit({ threshold: thresholdError(current.threshold, true) })
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
    }
  }
  if (!canUpdate)
    return (
      <p className="text-sm text-muted-foreground">
        {settings.enabled
          ? `Configured rule: pause schedules and webhooks after ${String(settings.effectiveThreshold)} failed runs in a row.`
          : 'Auto-pause is off for this workflow.'}{' '}
        Your role can’t change this rule.
      </p>
    );
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
            ? 'When enforcement is enabled, schedules and webhooks pause after repeated failures. Runs in progress finish; manual runs and replays still work.'
            : 'This workflow keeps starting runs however often it fails. Turning this off does not resume an existing pause.'
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
        description={`Leave blank to use the workspace default (${String(settings.workspaceThreshold)}). Changes apply to the next evaluation, without publishing; they do not resume a pause.`}
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
                thresholdError(event.target.value, true),
              );
            }}
          />
        )}
      </LabelledField>
      <p className="text-xs text-muted-foreground">
        Current configured rule:{' '}
        {settings.enabled
          ? `${String(settings.effectiveThreshold)} failures in a row`
          : 'off'}
        .
      </p>
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
        }}
      />
    </form>
  );
}

function WorkspaceDefaultForm({
  settings,
  scope,
}: Readonly<{ settings: WorkspaceAutoPauseSettings; scope: Scope }>) {
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
    if (!validation.submit({ threshold: thresholdError(current.threshold) }))
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
    }
  }
  return (
    <form
      className="mt-7 flex max-w-lg flex-col gap-4 border-t border-border pt-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <LabelledField
        id="workspace-auto-pause-threshold"
        label="Workspace default"
        description="Applies to all workflows in this workspace that have no override. Only workspace owners can change it. Enter 3–100."
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
                thresholdError(event.target.value),
              );
            }}
          />
        )}
      </LabelledField>
      <p className="text-xs text-muted-foreground">
        Current saved default: {String(settings.threshold)} failures in a row.
      </p>
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
        }}
      />
    </form>
  );
}

function WorkspaceDefault({ scope }: Readonly<{ scope: Scope }>) {
  const query = useQuery(
    workspaceAutoPauseQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
    ),
  );
  const settings = visibleSettingsData(query);
  return (
    <>
      <SettingsQueryState
        query={query}
        resource="The workspace auto-pause default"
      />
      {settings === undefined ? null : (
        <WorkspaceDefaultForm settings={settings} scope={scope} />
      )}
    </>
  );
}

export function AutoPauseSection(scope: Scope) {
  const query = useQuery(
    workflowAutoPauseQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
      scope.workflowId,
    ),
  );
  const settings = visibleSettingsData(query);
  return (
    <SettingsSection
      title="Automatic pause"
      description="Configure when repeated failures should stop scheduled and webhook runs."
    >
      <p className="mb-5 max-w-lg text-sm text-muted-foreground">
        Automatic pauses depend on enforcement being enabled for the deployment
        evaluator. Changing this rule does not enable it.
      </p>
      <SettingsQueryState query={query} resource="The auto-pause rule" />
      {settings === undefined ? null : (
        <WorkflowRule settings={settings} scope={scope} />
      )}
      {scope.workspace.capabilities.includes('workspace:manage') ? (
        <WorkspaceDefault scope={scope} />
      ) : settings === undefined ? null : (
        <p className="mt-5 text-sm text-muted-foreground">
          Workspace default: {String(settings.workspaceThreshold)} failures in a
          row. Only workspace owners can change it.
        </p>
      )}
    </SettingsSection>
  );
}
