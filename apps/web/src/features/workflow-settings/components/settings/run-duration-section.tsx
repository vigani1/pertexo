import { useState } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useNotifications } from '@/components/ui/use-notifications';
import { workflowDraftQueryOptions } from '@/features/workflow-editor/draft.public';
import type { ApiClient } from '@/lib/api/client';
import {
  RUN_DURATION_CHOICES,
  describeRunDuration,
  maxRunDurationOf,
} from '../../model/run-duration';
import { visibleSettingsData } from '../../model/settings-query';
import { useRunDurationChange } from '../../mutations/use-run-duration-change';
import { workflowVersionsQueryOptions } from '../../workflow-settings.queries';
import { SettingsSection } from '@/components/patterns/settings-section';
import { SettingsQueryState } from '../settings-section';
import { roleLimitSentence } from '@/features/workspaces/roles.public';

function choicesWith(current: number): readonly number[] {
  return RUN_DURATION_CHOICES.includes(current)
    ? RUN_DURATION_CHOICES
    : [...RUN_DURATION_CHOICES, current].sort((left, right) => left - right);
}

/** Where the draft stands against what runs today, in one sentence. */
function publishNote(
  draftMs: number,
  live: Readonly<{ versionNumber: number; durationMs: number }> | undefined,
): string {
  if (live === undefined || live.durationMs === draftMs)
    return 'Changes go into the draft. Publish to apply them to new runs.';
  return `The draft says ${describeRunDuration(draftMs)}. Live v${String(live.versionNumber)} stops runs after ${describeRunDuration(live.durationMs)} until you publish.`;
}

/**
 * The longest a run of this workflow may take before Pertexo stops it, up to
 * an hour. Changing it edits the draft; publishing applies it.
 */
export function RunDurationSection({
  apiClient,
  userId,
  workspace,
  workflow,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary | undefined;
}>) {
  const workflowId = workflow?.id;
  const canUpdate = workspace.capabilities.includes('workflow:update');
  const archived = workflow?.lifecycleStatus === 'archived';
  const notifications = useNotifications();
  const draft = useQuery({
    ...workflowDraftQueryOptions(
      apiClient,
      userId,
      workspace.id,
      workflowId ?? '',
    ),
    enabled: workflowId !== undefined,
  });
  const versions = useQuery({
    ...workflowVersionsQueryOptions(
      apiClient,
      userId,
      workspace.id,
      workflowId ?? '',
    ),
    enabled: workflowId !== undefined && workflow?.publishedVersionId !== null,
  });
  const change = useRunDurationChange({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId: workflowId ?? '',
  });
  const [requested, setRequested] = useState<number>();
  const [unsaved, setUnsaved] = useState<number>();
  const snapshot = visibleSettingsData(draft);
  const draftMs =
    snapshot === undefined
      ? undefined
      : (requested ?? maxRunDurationOf(snapshot.draft.graph));
  const liveVersion = visibleSettingsData(versions)?.items.find(
    (version) => version.id === workflow?.publishedVersionId,
  );
  const live =
    liveVersion === undefined
      ? undefined
      : {
          versionNumber: liveVersion.versionNumber,
          durationMs: maxRunDurationOf(liveVersion.graph),
        };

  async function choose(durationMs: number) {
    setRequested(durationMs);
    const saved = await change.apply(durationMs);
    setRequested(undefined);
    setUnsaved(saved ? undefined : durationMs);
    if (saved)
      notifications.success({
        title: `Runs may take up to ${describeRunDuration(durationMs)} in the draft`,
        description: 'Publish to apply it to new runs.',
      });
  }

  return (
    <SettingsSection
      title="Run duration"
      description="How long a run may take before Pertexo stops it, up to 1 hour."
    >
      <SettingsQueryState query={draft} resource="The draft" />
      {draftMs === undefined ? null : !canUpdate ? (
        <p className="text-sm text-muted-foreground">
          Runs stop after {describeRunDuration(draftMs)} in the draft.{' '}
          {roleLimitSentence(
            workspace.role,
            'workflow:update',
            'change how long runs may take',
          )}
        </p>
      ) : (
        <Field>
          <FieldLabel id="run-duration-label">Maximum run duration</FieldLabel>
          <div className="flex flex-wrap items-center gap-3">
            <Select
              items={choicesWith(draftMs).map((choice) => ({
                value: String(choice),
                label: describeRunDuration(choice),
              }))}
              value={String(draftMs)}
              disabled={archived || change.pending}
              onValueChange={(value) => {
                if (typeof value === 'string') void choose(Number(value));
              }}
            >
              <SelectTrigger
                aria-labelledby="run-duration-label"
                aria-describedby="run-duration-note"
                className="w-48"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choicesWith(draftMs).map((choice) => (
                  <SelectItem key={choice} value={String(choice)}>
                    {describeRunDuration(choice)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {change.pending ? (
              <span
                role="status"
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <LoadingOrb />
                Saving to the draft…
              </span>
            ) : null}
          </div>
          <FieldDescription id="run-duration-note">
            {archived
              ? 'Restore the workflow to change this.'
              : publishNote(draftMs, live)}
          </FieldDescription>
        </Field>
      )}
      {change.problem === undefined ? null : (
        <Notice
          tone={change.problem.retry ? 'warning' : 'destructive'}
          action={
            change.problem.retry && unsaved !== undefined ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void choose(unsaved)}
              >
                Apply again
              </Button>
            ) : undefined
          }
        >
          {change.problem.message}
        </Notice>
      )}
    </SettingsSection>
  );
}
