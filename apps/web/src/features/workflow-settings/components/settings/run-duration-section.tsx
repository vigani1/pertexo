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

type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflow: WorkflowSummary | undefined;
}>;

/** The draft's run duration and the live version's, when there is one. */
function useStoredDurations({
  apiClient,
  userId,
  workspaceId,
  workflow,
}: Scope) {
  const workflowId = workflow?.id;
  const draft = useQuery({
    ...workflowDraftQueryOptions(
      apiClient,
      userId,
      workspaceId,
      workflowId ?? '',
    ),
    enabled: workflowId !== undefined,
  });
  const versions = useQuery({
    ...workflowVersionsQueryOptions(
      apiClient,
      userId,
      workspaceId,
      workflowId ?? '',
    ),
    enabled: workflowId !== undefined && workflow?.publishedVersionId !== null,
  });
  const snapshot = visibleSettingsData(draft);
  const liveVersion = visibleSettingsData(versions)?.items.find(
    (version) => version.id === workflow?.publishedVersionId,
  );
  return {
    draft,
    draftMs:
      snapshot === undefined
        ? undefined
        : maxRunDurationOf(snapshot.draft.graph),
    live:
      liveVersion === undefined
        ? undefined
        : {
            versionNumber: liveVersion.versionNumber,
            durationMs: maxRunDurationOf(liveVersion.graph),
          },
  } as const;
}

/**
 * Choosing a duration: shown straight away while it saves to the draft, and
 * kept for "Apply again" when the save's outcome is unknown.
 */
function useDurationChoice({
  apiClient,
  userId,
  workspaceId,
  workflow,
}: Scope) {
  const notifications = useNotifications();
  const change = useRunDurationChange({
    apiClient,
    userId,
    workspaceId,
    workflowId: workflow?.id ?? '',
  });
  const [requested, setRequested] = useState<number>();
  const [unsaved, setUnsaved] = useState<number>();

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

  return {
    requested,
    unsaved,
    pending: change.pending,
    problem: change.problem,
    choose,
  } as const;
}

/** The duration select, a saving line beside it and a note under it. */
function DurationPicker({
  durationMs,
  disabled,
  saving,
  note,
  onChoose,
}: Readonly<{
  durationMs: number;
  disabled: boolean;
  saving: boolean;
  note: string;
  onChoose: (durationMs: number) => void;
}>) {
  const choices = choicesWith(durationMs);
  return (
    <Field>
      <FieldLabel id="run-duration-label">Maximum run duration</FieldLabel>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          items={choices.map((choice) => ({
            value: String(choice),
            label: describeRunDuration(choice),
          }))}
          value={String(durationMs)}
          disabled={disabled}
          onValueChange={(value) => {
            if (typeof value === 'string') onChoose(Number(value));
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
            {choices.map((choice) => (
              <SelectItem key={choice} value={String(choice)}>
                {describeRunDuration(choice)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {saving ? (
          <span
            role="status"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <LoadingOrb />
            Saving to the draft…
          </span>
        ) : null}
      </div>
      <FieldDescription id="run-duration-note">{note}</FieldDescription>
    </Field>
  );
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
  const scope = { apiClient, userId, workspaceId: workspace.id, workflow };
  const stored = useStoredDurations(scope);
  const choice = useDurationChoice(scope);
  const canUpdate = workspace.capabilities.includes('workflow:update');
  const archived = workflow?.lifecycleStatus === 'archived';
  const draftMs =
    stored.draftMs === undefined
      ? undefined
      : (choice.requested ?? stored.draftMs);

  return (
    <SettingsSection
      title="Run duration"
      description="How long a run may take before Pertexo stops it, up to 1 hour."
    >
      <SettingsQueryState query={stored.draft} resource="The draft" />
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
        <DurationPicker
          durationMs={draftMs}
          disabled={archived || choice.pending}
          saving={choice.pending}
          note={
            archived
              ? 'Restore the workflow to change this.'
              : publishNote(draftMs, stored.live)
          }
          onChoose={(durationMs) => void choice.choose(durationMs)}
        />
      )}
      {choice.problem === undefined ? null : (
        <Notice
          tone={choice.problem.retry ? 'warning' : 'destructive'}
          action={
            choice.problem.retry && choice.unsaved !== undefined ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (choice.unsaved !== undefined)
                    void choice.choose(choice.unsaved);
                }}
              >
                Apply again
              </Button>
            ) : undefined
          }
        >
          {choice.problem.message}
        </Notice>
      )}
    </SettingsSection>
  );
}
