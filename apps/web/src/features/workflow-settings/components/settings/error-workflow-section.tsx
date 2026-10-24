import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowErrorSettings,
} from '@pertexo/contracts';
import { SettingSentence } from '@/components/patterns/settings/sentence';
import { SettingsSection } from '@/components/patterns/settings/section';
import { LabelledField, FieldGroup } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { QueryView } from '@/components/patterns/states/query-view';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  errorWorkflowQuery,
  errorTargetsQuery,
} from '../../data/error-workflow/queries';
import { useErrorWorkflowCommand } from '../../data/error-workflow/use-command';
import { visibleSettingsData } from '../../model/settings-query';
import { settingsReadFailure } from '../settings-read-failure';

type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;
type ErrorWorkflowEditorProps = Readonly<{
  scope: Scope;
  settings: WorkflowErrorSettings;
  onSaved: () => void;
}>;

function ErrorWorkflowEditor(props: ErrorWorkflowEditorProps) {
  const model = useErrorWorkflowForm(props);
  return (
    <form
      className="flex max-w-lg flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void model.submit();
      }}
    >
      <FieldGroup>
        <LabelledField
          id="error-workflow-target"
          label="When this workflow fails, run …"
          description="Published workflows that start with When a workflow fails."
        >
          {(control) => (
            <Select
              items={model.options}
              value={model.current.target ?? 'none'}
              onValueChange={(value) => {
                if (typeof value === 'string')
                  model.setDraft({
                    target: value === 'none' ? null : value,
                    revision: model.current.revision,
                  });
              }}
              disabled={model.command.pending || model.command.unconfirmed}
            >
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {model.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </LabelledField>
      </FieldGroup>
      <QueryView
        query={model.targets}
        resource="Error workflow choices"
        failure={settingsReadFailure}
      />
      <LoadMore
        subject="workflows"
        label="More workflows"
        hasNextPage={model.targets.hasNextPage}
        loading={model.targets.isFetchingNextPage}
        failed={model.targets.isFetchNextPageError}
        onLoadMore={() => void model.targets.fetchNextPage()}
      />
      {model.available.length === 0 &&
      !model.targets.isPending &&
      !model.targets.isError ? (
        <p className="text-sm text-muted-foreground">
          Publish a workflow with When a workflow fails to make it available
          here.
        </p>
      ) : null}
      {model.command.problem === undefined ? null : (
        <Notice
          tone={model.command.unconfirmed ? 'warning' : 'destructive'}
          action={
            model.command.unconfirmed ? (
              <ProgressButton
                type="button"
                variant="outline"
                pending={model.command.pending}
                pendingLabel="Retrying…"
                onClick={() => {
                  void model.command.retry().then((success) => {
                    if (success) model.saved();
                  });
                }}
              >
                Retry same change
              </ProgressButton>
            ) : undefined
          }
        >
          {model.command.problem}
        </Notice>
      )}
      <ProgressButton
        type="submit"
        className="self-start"
        pending={model.command.pending}
        pendingLabel="Saving…"
        disabled={
          model.command.unconfirmed ||
          model.current.target === model.settings.targetWorkflowId
        }
      >
        Save error workflow
      </ProgressButton>
    </form>
  );
}

function useErrorWorkflowForm({
  scope,
  settings,
  onSaved,
}: ErrorWorkflowEditorProps) {
  const [draft, setDraft] =
    useState<Readonly<{ target: string | null; revision: number }>>();
  const current = draft ?? {
    target: settings.targetWorkflowId,
    revision: settings.revision,
  };
  const targets = useInfiniteQuery(
    errorTargetsQuery(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
      scope.workflowId,
    ),
  );
  const available =
    visibleSettingsData(targets)?.pages.flatMap((page) => page.items) ?? [];
  const command = useErrorWorkflowCommand(
    scope.apiClient,
    scope.userId,
    scope.workspace.id,
    scope.workflowId,
  );
  const notifications = useNotifications();
  const options = [
    { value: 'none', label: 'Do not run another workflow' },
    ...available.map((target) => ({ value: target.id, label: target.name })),
  ];
  if (
    current.target !== null &&
    !options.some((option) => option.value === current.target)
  )
    options.push({
      value: current.target,
      label: settings.targetWorkflowName ?? 'Selected workflow is unavailable',
    });
  const saved = () => {
    setDraft(undefined);
    notifications.success({ title: 'Error workflow saved' });
    onSaved();
  };
  async function submit() {
    if (
      await command.send({
        targetWorkflowId: current.target,
        expectedRevision: command.conflict
          ? settings.revision
          : current.revision,
      })
    )
      saved();
  }

  return {
    submit,
    options,
    current,
    setDraft,
    command,
    targets,
    available,
    saved,
    settings,
  } as const;
}
export function ErrorWorkflowSection(scope: Scope) {
  const [editing, setEditing] = useState(false);
  const canRead = scope.workspace.capabilities.includes('workflow:read');
  const query = useQuery({
    ...errorWorkflowQuery(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
      scope.workflowId,
    ),
    enabled: canRead,
  });
  const editable =
    scope.workspace.status === 'active' &&
    scope.workspace.capabilities.includes('workflow:update');
  return (
    <SettingsSection
      title="Error workflow"
      description="Another workflow to run when this one fails."
    >
      {canRead ? (
        <QueryView
          query={query}
          resource="Error workflow settings"
          failure={settingsReadFailure}
        >
          {(settings) => (
            <SettingSentence
              summary={
                <>
                  {settings.targetWorkflowId === null ? (
                    <>
                      <b>Nothing else runs</b> when this workflow fails.
                    </>
                  ) : (
                    <>
                      When this workflow fails, Pertexo runs{' '}
                      <b>
                        {settings.targetWorkflowName ??
                          'a workflow you can’t open'}
                      </b>
                      .
                    </>
                  )}
                  {editable
                    ? null
                    : ' Changing it takes edit access to both workflows.'}
                </>
              }
              editing={editing}
              onEditingChange={setEditing}
              {...(editable
                ? {
                    editor: (
                      <ErrorWorkflowEditor
                        scope={scope}
                        settings={settings}
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
                    Only failures nothing handled start it; handled failures and
                    canceled runs don’t.
                  </p>
                  <p>
                    It receives a short summary and a link to the run, never the
                    run’s data. It uses normal run limits, and its own failures
                    never start another error workflow.
                  </p>
                </>
              }
            />
          )}
        </QueryView>
      ) : null}
    </SettingsSection>
  );
}
