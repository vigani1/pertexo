import { useState } from 'react';
import type { WorkspaceAutoPauseSettings } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { SettingSentence } from '@/components/patterns/settings/sentence';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import { workspaceAutoPauseQueryOptions } from '../../data/auto-pause.queries';
import { useAutoPauseCommand } from '../../data/mutations/use-auto-pause-command';
import { QueryView } from '@/components/patterns/states/query-view';
import { settingsReadFailure } from '../settings-read-failure';
import type { Scope } from './auto-pause-fields';
import { thresholdError } from './auto-pause-input';
import { CommandProblem } from './auto-pause-fields';

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

export function WorkspaceDefault({ scope }: Readonly<{ scope: Scope }>) {
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
