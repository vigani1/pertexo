import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowErrorSettings,
} from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings-section';
import { LabelledField, FieldGroup } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
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
import { SettingsQueryState } from '../settings-query-state';

type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;
function ErrorWorkflowEditor({
  scope,
  settings,
}: Readonly<{ scope: Scope; settings: WorkflowErrorSettings }>) {
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
  return (
    <form
      className="flex max-w-lg flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <FieldGroup>
        <LabelledField
          id="error-workflow-target"
          label="When this workflow fails, run …"
          description="Choose a published workflow with the When a workflow fails trigger. It receives a safe summary and a run link. Run data is never sent."
        >
          {(control) => (
            <Select
              items={options}
              value={current.target ?? 'none'}
              onValueChange={(value) => {
                if (typeof value === 'string')
                  setDraft({
                    target: value === 'none' ? null : value,
                    revision: current.revision,
                  });
              }}
              disabled={command.pending || command.unconfirmed}
            >
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {options.map((option) => (
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
      <SettingsQueryState query={targets} resource="Error workflow choices" />
      {targets.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={targets.isFetchingNextPage}
          onClick={() => void targets.fetchNextPage()}
        >
          More workflows
        </Button>
      ) : null}
      {available.length === 0 && !targets.isPending && !targets.isError ? (
        <p className="text-sm text-muted-foreground">
          Publish a workflow with When a workflow fails to make it available
          here.
        </p>
      ) : null}
      {command.problem === undefined ? null : (
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
                    if (success) saved();
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
      )}
      <ProgressButton
        type="submit"
        className="self-start"
        pending={command.pending}
        pendingLabel="Saving…"
        disabled={
          command.unconfirmed || current.target === settings.targetWorkflowId
        }
      >
        Save error workflow
      </ProgressButton>
    </form>
  );
}
export function ErrorWorkflowSection(scope: Scope) {
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
  const settings = canRead ? visibleSettingsData(query) : undefined;
  const editable =
    scope.workspace.status === 'active' &&
    scope.workspace.capabilities.includes('workflow:update');
  return (
    <SettingsSection
      title="Error workflow"
      description="Run a separate workflow after an unhandled failure. Handled failures and canceled runs do not start it."
    >
      <SettingsQueryState query={query} resource="Error workflow settings" />
      {settings === undefined ? null : editable ? (
        <ErrorWorkflowEditor scope={scope} settings={settings} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {settings.targetWorkflowId === null
            ? 'No error workflow selected.'
            : 'An error workflow is selected.'}{' '}
          Editing both workflows is required to change this setting.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Error workflows use normal run limits. Their failures never start
        another error workflow.
      </p>
    </SettingsSection>
  );
}
