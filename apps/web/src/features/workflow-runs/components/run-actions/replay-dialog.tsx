import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Link } from '@tanstack/react-router';
import { Notice } from '@/components/ui/notice';
import { ChoiceCards } from '@/components/patterns/choice-cards';
import { GitBranchIcon, RotateCcwIcon } from 'lucide-react';
import { workflowRunVersionQueryOptions } from '../../data/detail.queries';
import type {
  WorkflowRunData,
  AccessibleWorkspace,
  WorkflowRunReadSummary,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { useRunReplay } from '../../data/mutations/use-run-replay';
import { useNewerPublishedVersion } from '../../hooks/use-newer-published-version';
import { useRunInput } from '../../hooks/use-run-input';
import { workflowRunInputQueryOptions } from '../../data/stored-values.queries';
import { RunInputFields } from '../run-input-fields';

function useSourceVersion({
  apiClient,
  userId,
  workspace,
  source,
  open,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: Pick<AccessibleWorkspace, 'id' | 'capabilities'>;
  source: Pick<
    WorkflowRunReadSummary,
    'id' | 'workflowId' | 'workflowVersionId' | 'triggerType'
  >;
  open: boolean;
}>) {
  const version = useQuery({
    ...workflowRunVersionQueryOptions({
      apiClient,
      userId,
      workspaceId: workspace.id,
      workflowId: source.workflowId,
      versionId: source.workflowVersionId,
    }),
    enabled: open && workspace.capabilities.includes('workflow:read'),
  });
  return {
    formReplay:
      source.triggerType === 'form' ||
      (version.data?.graph.nodes.some(
        (node) =>
          node.definition.key === 'core.form' && node.definition.version === 1,
      ) ??
        false),
    sourceVersionNumber: version.data?.versionNumber,
  };
}

/** Which version a replay runs: the published one by default, once it isn't this run's. */
function useReplayVersion({
  apiClient,
  userId,
  workspace,
  source,
  versionLabel,
  open,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: Pick<AccessibleWorkspace, 'id' | 'capabilities'>;
  source: Pick<
    WorkflowRunReadSummary,
    'id' | 'workflowId' | 'workflowVersionId' | 'triggerType'
  >;
  versionLabel: string | undefined;
  open: boolean;
}>) {
  const { formReplay, sourceVersionNumber } = useSourceVersion({
    apiClient,
    userId,
    workspace,
    source,
    open,
  });
  const published = useNewerPublishedVersion({
    apiClient,
    userId,
    workspace,
    source,
    enabled: open,
  });
  const [choice, setChoice] = useState<'newer' | 'source'>('newer');
  const sourceLabel =
    versionLabel ??
    (sourceVersionNumber === undefined
      ? undefined
      : `v${String(sourceVersionNumber)}`);
  const newer = choice === 'newer' ? published.newer : undefined;
  return {
    formReplay,
    pending: published.pending,
    newerNumber: published.newer?.versionNumber,
    sourceLabel,
    choice,
    setChoice,
    workflowVersionId: newer?.id ?? source.workflowVersionId,
    label:
      newer === undefined ? sourceLabel : `v${String(newer.versionNumber)}`,
  };
}

function ReplayVersionChoice({
  version,
  disabled,
}: Readonly<{
  version: ReturnType<typeof useReplayVersion>;
  disabled: boolean;
}>) {
  if (version.newerNumber === undefined) return null;
  return (
    <ChoiceCards
      legend="Version to run"
      value={version.choice}
      disabled={disabled}
      onChange={version.setChoice}
      choices={[
        {
          value: 'newer',
          label: `v${String(version.newerNumber)}, published now`,
          hint: 'Runs what’s live today, including any fix made since this run.',
          glyph: <GitBranchIcon aria-hidden="true" className="size-3.5" />,
        },
        {
          value: 'source',
          label: version.sourceLabel ?? 'The version this run used',
          hint: 'Runs exactly what this run ran, so it can fail the same way.',
          glyph: <RotateCcwIcon aria-hidden="true" className="size-3.5" />,
        },
      ]}
    />
  );
}

/** The original input as the text the field shows, while it's still kept. */
function originalInputText(data: WorkflowRunData | undefined) {
  return data?.kind === 'inline'
    ? JSON.stringify(data.value, null, 2)
    : undefined;
}

/** Captured input initializes the editor once; a late read never erases a person's edits. */
function useReplayInput({
  originalText,
  open,
  unconfirmed,
}: Readonly<{
  originalText: string | undefined;
  open: boolean;
  unconfirmed: boolean;
}>) {
  const runInput = useRunInput();
  // Each time it opens, the field starts from the run's own input, and an
  // input that loads after opening fills a field nobody has typed in yet.
  const [seen, setSeen] = useState({ open, text: originalText });
  if (open !== seen.open || originalText !== seen.text) {
    const opening = open && !seen.open;
    const arrived =
      open && seen.open && seen.text === undefined && runInput.input === '{}';
    setSeen({ open, text: originalText });
    if ((opening || arrived) && !unconfirmed) runInput.reset(originalText);
  }

  return runInput;
}

/** Copy follows whether the original input is still available, not query timing. */
function replayDescription(
  data: WorkflowRunData | undefined,
  text: string | undefined,
  versionLabel: string | undefined,
): string {
  const version = versionLabel ?? 'the same version';
  if (text !== undefined)
    return `Pertexo starts a new run of ${version} with this run’s input. Change it first if you need to: steps that call other services run again.`;
  if (data?.kind === 'expired')
    return `Pertexo starts a new run of ${version}. This run’s input is no longer kept, so enter the input to use. Steps that call other services run again.`;
  return `Pertexo starts a new run of ${version} with the input you enter here. Steps that call other services run again, so check it before you continue.`;
}

/**
 * Replay starts a new run from the start, on the version published now when a
 * fix has landed since this run, or on this run's own. It opens with the input
 * the run used while Pertexo still keeps it (ADR 050), and an uncertain result
 * retains the same command within the acceptance receipt's 24-hour window.
 */
export function ReplayRunDialog({
  apiClient,
  userId,
  workspace,
  source,
  versionLabel,
  open,
  onOpenChange,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: Pick<AccessibleWorkspace, 'id' | 'capabilities'>;
  source: Pick<
    WorkflowRunReadSummary,
    'id' | 'workflowId' | 'workflowVersionId' | 'triggerType'
  >;
  /** "v7" when the version number is known. */
  versionLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRunAccepted: (runId: string) => void;
}>) {
  const { id: workspaceId } = workspace;
  const { id: sourceRunId, workflowId } = source;
  const notifications = useNotifications();
  const version = useReplayVersion({
    apiClient,
    userId,
    workspace,
    source,
    versionLabel,
    open,
  });
  const { formReplay } = version;
  const original = useQuery(
    workflowRunInputQueryOptions(apiClient, userId, workspaceId, sourceRunId),
  );
  const replay = useRunReplay({
    apiClient,
    userId,
    workspaceId,
    sourceRunId,
    workflowVersionId: version.workflowVersionId,
    onRunAccepted: (runId) => {
      notifications.success({
        title: 'Replay started',
        description: 'Opening the new run.',
      });
      onRunAccepted(runId);
    },
  });
  const originalText = originalInputText(original.data);
  const runInput = useReplayInput({
    originalText,
    open,
    unconfirmed: replay.unconfirmed,
  });
  async function submit() {
    const intent = runInput.read();
    if (intent === undefined) return;
    const accepted = replay.retryAvailable
      ? await replay.retry(intent)
      : await replay.startNew(intent);
    if (accepted) onOpenChange(false);
  }

  function changeOpen(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      replay.dismiss();
      if (!replay.unconfirmed) runInput.reset();
    }
  }

  const needsCapturedInput = formReplay && originalText === undefined;
  const cannotStart = replay.expired || version.pending || needsCapturedInput;
  return (
    <ConfirmDialog
      state={{ open: open, onOpenChange: changeOpen, locked: replay.pending }}
      title="Replay this run"
      description={
        formReplay
          ? 'Replay repeats the exact captured form response. Steps that call other services run again. Use the published form to send a new response.'
          : replayDescription(original.data, originalText, version.label)
      }
      onSubmit={submit}
      submitDisabled={replay.pending || cannotStart}
      footer={
        <ConfirmationFooter>
          <DialogClose
            disabled={replay.pending}
            render={<Button type="button" variant="ghost" />}
          >
            Cancel
          </DialogClose>
          <ProgressButton
            type="submit"
            variant="primary"
            pending={replay.pending}
            pendingLabel="Replaying…"
            disabled={cannotStart}
          >
            {replay.retryAvailable ? 'Retry same replay' : 'Replay run'}
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        error={replay.error}
        tone={replay.retryAvailable ? 'warning' : 'destructive'}
      >
        <ReplayVersionChoice
          version={version}
          disabled={replay.pending || replay.unconfirmed}
        />
        <p className="text-sm text-muted-foreground">
          Replay keeps the source run’s workspace variables. Start a new run to
          use current values.
        </p>
        <RunInputFields
          idPrefix="replay-run"
          inputLabel="Replay input (JSON)"
          runInput={runInput}
          disabled={replay.pending || replay.unconfirmed}
          inputReadOnly={formReplay}
        />
        {formReplay ? (
          <Notice
            action={
              <Link
                to="/w/$workspaceId/forms/$workflowId"
                params={{ workspaceId, workflowId }}
                className="underline underline-offset-4"
              >
                Open workflow form
              </Link>
            }
          >
            The original fields, submitter and submission time stay fixed. If
            the captured input expired, send a new response.
          </Notice>
        ) : null}
      </ConfirmationDetails>
    </ConfirmDialog>
  );
}
