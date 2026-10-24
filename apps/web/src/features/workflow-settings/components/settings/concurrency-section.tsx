import { OverflowPicker } from './concurrency/overflow';
import { SkipHistory } from './concurrency/history';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowConcurrencySettings,
} from '@pertexo/contracts';
import { SettingSentence } from '@/components/patterns/settings/sentence';
import { SettingsSection } from '@/components/patterns/settings/section';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format/time';
import {
  concurrencyKey,
  concurrencyQueryOptions,
} from '../../data/concurrency.queries';
import { useConcurrencyCommand } from '../../data/mutations/use-concurrency-command';
import { QueryView } from '@/components/patterns/states/query-view';
import { settingsReadFailure } from '../settings-read-failure';

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
  onSaved,
}: Readonly<{
  settings: WorkflowConcurrencySettings;
  scope: Scope;
  onSaved: () => void;
}>) {
  const [draft, setDraft] =
    useState<
      Readonly<{ value: string; revision: number; overflow: 'queue' | 'skip' }>
    >();
  const current = draft ?? {
    value: settings.limit === null ? '' : String(settings.limit),
    revision: settings.revision,
    overflow: settings.overflow,
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
    onSaved();
  };
  async function submit() {
    if (
      !canUpdate ||
      !validation.submit({ limit: limitError(current.value, settings) })
    )
      return;
    if (
      await command.send({
        overflow: current.overflow,
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
        description="Leave blank for no limit of its own."
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
                overflow: current.overflow,
              });
              validation.change(
                'limit',
                limitError(event.target.value, settings),
              );
            }}
          />
        )}
      </LabelledField>
      <OverflowPicker
        value={current.overflow}
        disabled={command.pending || command.unconfirmed}
        onChange={(overflow) => {
          setDraft({ ...current, overflow });
        }}
      />
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

/** The limit in words: how many at once and what happens to the rest. */
function limitSummary(settings: WorkflowConcurrencySettings) {
  const workspaceLimit =
    settings.workspacePolicyState === 'active'
      ? settings.workspaceActiveRunLimit
      : null;
  if (settings.limit === null)
    return (
      <>
        <b>No limit</b> of its own.{' '}
        {workspaceLimit === null
          ? 'Workspace limits still apply.'
          : `The workspace runs up to ${String(workspaceLimit)} at once.`}
      </>
    );
  return (
    <>
      Up to{' '}
      <b>
        {settings.limit} {settings.limit === 1 ? 'run' : 'runs'}
      </b>{' '}
      at once.{' '}
      {settings.overflow === 'queue' ? (
        <>
          Extra events <b>wait their turn</b>.
        </>
      ) : (
        <>
          Extra trigger events are <b>skipped</b>; manual starts are refused.
        </>
      )}
    </>
  );
}

function ConcurrencyPolicy({
  settings,
  scope,
}: Readonly<{ settings: WorkflowConcurrencySettings; scope: Scope }>) {
  const [editing, setEditing] = useState(false);
  const canUpdate =
    scope.workspace.status === 'active' &&
    scope.workspace.capabilities.includes('workflow:update');
  return (
    <div className="flex flex-col gap-5">
      <SettingSentence
        summary={
          <>
            {limitSummary(settings)}
            {canUpdate
              ? null
              : ' Your role or the workspace’s state doesn’t allow changing it.'}
          </>
        }
        editing={editing}
        onEditingChange={setEditing}
        {...(canUpdate
          ? {
              editor: (
                <ConcurrencyEditor
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
              Running and waiting runs, plus starts already reserved, take a
              place across every published version. Calls and draft tests always
              queue.
            </p>
            <p>
              Runs start in the order they arrived; when they finish, and what
              they change elsewhere, can differ. Lowering the limit doesn’t stop
              runs already going, and pausing triggers doesn’t pause runs
              already accepted.
            </p>
            <p>
              As of{' '}
              <time dateTime={settings.asOf} title={settings.asOf}>
                {formatDateTime(settings.asOf)}
              </time>
              .{' '}
              {settings.workspacePolicyState === 'active' &&
              settings.workspaceActiveRunLimit !== null
                ? `The workspace allows ${String(settings.workspaceActiveRunLimit)} active runs.`
                : 'The workspace has no active run allowance, so only removing the limit is possible.'}
            </p>
          </>
        }
      />
      <SkipHistory items={settings.recentSkips ?? []} />
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
  return (
    <SettingsSection
      title="Concurrency"
      description="How many runs of this workflow can go at once."
    >
      {canRead ? (
        <QueryView
          query={query}
          resource="The concurrency settings"
          failure={settingsReadFailure}
        >
          {(settings) => (
            <ConcurrencyPolicy settings={settings} scope={scope} />
          )}
        </QueryView>
      ) : (
        <p className="text-sm text-muted-foreground">
          Your role can’t read these settings.
        </p>
      )}
    </SettingsSection>
  );
}
