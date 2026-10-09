import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowConcurrencySettings,
} from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings-section';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format-time';
import {
  concurrencyKey,
  concurrencyQueryOptions,
} from '../../concurrency.queries';
import { useConcurrencyCommand } from '../../mutations/use-concurrency-command';
import { visibleSettingsData } from '../../model/settings-query';
import { SettingsQueryState } from '../settings-query-state';

type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;

function limitError(
  value: string,
  settings: WorkflowConcurrencySettings,
): string | undefined {
  if (value.trim() === '') return undefined;
  if (
    settings.workspacePolicyState !== 'active' ||
    settings.workspaceActiveRunLimit === null
  )
    return 'An active workspace execution allowance is required to set a limit. You can still remove the workflow limit.';
  return /^\d+$/u.test(value) &&
    Number(value) >= 1 &&
    Number(value) <= settings.workspaceActiveRunLimit
    ? undefined
    : `Enter a whole number from 1 to ${String(settings.workspaceActiveRunLimit)}.`;
}

function ConcurrencyProblem({
  command,
  onSaved,
}: Readonly<{
  command: ReturnType<typeof useConcurrencyCommand>;
  onSaved: () => void;
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
              void command.retry().then((success) => {
                if (success) onSaved();
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

function ConcurrencyEditor({
  settings,
  scope,
}: Readonly<{ settings: WorkflowConcurrencySettings; scope: Scope }>) {
  const [draft, setDraft] =
    useState<Readonly<{ value: string; revision: number }>>();
  const current = draft ?? {
    value: settings.limit === null ? '' : String(settings.limit),
    revision: settings.revision,
  };
  const validation = useFieldValidation<'limit'>();
  const command = useConcurrencyCommand(
    scope.apiClient,
    scope.userId,
    scope.workspace.id,
    scope.workflowId,
  );
  const notifications = useNotifications();
  const canUpdate =
    scope.workspace.status === 'active' &&
    scope.workspace.capabilities.includes('workflow:update');
  const saved = () => {
    setDraft(undefined);
    notifications.success({ title: 'Concurrency settings saved' });
  };
  async function submit() {
    if (
      !canUpdate ||
      !validation.submit({ limit: limitError(current.value, settings) })
    )
      return;
    if (
      await command.send({
        limit: current.value.trim() === '' ? null : Number(current.value),
        expectedRevision: command.conflict
          ? settings.revision
          : current.revision,
      })
    )
      saved();
  }
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <LabelledField
        id="workflow-concurrency-limit"
        label="Runs at once"
        description="Leave blank to remove the workflow limit. Running and waiting runs, plus reserved starts, occupy slots across all published versions."
        error={validation.error('limit')}
      >
        {(control) => (
          <Input
            {...control}
            ref={validation.register('limit')}
            name="concurrencyLimit"
            inputMode="numeric"
            autoComplete="off"
            value={current.value}
            disabled={command.pending || command.unconfirmed}
            onChange={(event) => {
              setDraft({
                value: event.target.value,
                revision: current.revision,
              });
              validation.change(
                'limit',
                limitError(event.target.value, settings),
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
          Save concurrency limit
        </ProgressButton>
      </div>
      <ConcurrencyProblem command={command} onSaved={saved} />
    </form>
  );
}

function ConcurrencyPolicy({
  settings,
  scope,
}: Readonly<{ settings: WorkflowConcurrencySettings; scope: Scope }>) {
  const canUpdate =
    scope.workspace.status === 'active' &&
    scope.workspace.capabilities.includes('workflow:update');
  return (
    <div className="flex max-w-lg flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Current limit:{' '}
        {settings.limit === null
          ? 'no additional workflow limit'
          : `${String(settings.limit)} active ${settings.limit === 1 ? 'run' : 'runs'}`}
        . Workspace limits still apply.
      </p>
      {canUpdate ? (
        <ConcurrencyEditor settings={settings} scope={scope} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Your role or workspace state doesn’t allow changing this limit.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Extra runs wait their turn in acceptance order. Starts are ordered, not
        completion or external effects. Lowering the limit does not stop active
        runs or revoke reserved starts. Pausing triggers does not pause already
        accepted runs.
      </p>
      <p className="text-xs text-muted-foreground">
        Observed{' '}
        <time dateTime={settings.asOf} title={settings.asOf}>
          {formatDateTime(settings.asOf)}
        </time>
        .
        {settings.workspacePolicyState === 'active' &&
        settings.workspaceActiveRunLimit !== null
          ? ` Current workspace active-run allowance: ${String(settings.workspaceActiveRunLimit)}.`
          : ' The workspace has no active execution allowance for setting a limit.'}
      </p>
    </div>
  );
}

export function ConcurrencySection(scope: Scope) {
  const canRead = scope.workspace.capabilities.includes('workflow:read');
  const cache = useQueryClient();
  const userId = scope.userId;
  const workspaceId = scope.workspace.id;
  const workflowId = scope.workflowId;
  useEffect(() => {
    if (canRead) return;
    const queryKey = concurrencyKey(userId, workspaceId, workflowId);
    void cache.cancelQueries({ queryKey, exact: true }).then(() => {
      cache
        .getQueryCache()
        .find({ queryKey, exact: true })
        ?.setState({ data: undefined, dataUpdatedAt: 0 });
    });
  }, [cache, canRead, userId, workspaceId, workflowId]);
  const query = useQuery({
    ...concurrencyQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
      scope.workflowId,
    ),
    enabled: canRead,
  });
  const settings = canRead ? visibleSettingsData(query) : undefined;
  return (
    <SettingsSection
      title="Concurrency"
      description="Control how many production runs of this workflow can be active at once."
    >
      {canRead ? (
        <SettingsQueryState query={query} resource="The concurrency settings" />
      ) : (
        <p className="text-sm text-muted-foreground">
          Your role can’t read these settings.
        </p>
      )}
      {settings === undefined ? null : (
        <ConcurrencyPolicy settings={settings} scope={scope} />
      )}
    </SettingsSection>
  );
}
