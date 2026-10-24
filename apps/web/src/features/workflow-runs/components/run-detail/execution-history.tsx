import { formatDateTime } from '@/lib/format/time';
import { shortRunId } from '../../model/list/runs';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { StatusGlyph } from '@/components/ui/status';
import { describeStepError } from '../../model/step-inspection/step-error-copy';
import {
  storyEntryMeta,
  storyEntryReason,
  storyEntryTitle,
} from '../../model/step-inspection/step-copy';
import type { StepStoryEntry } from '../../model/timeline/step-replay';
import type { RunTimelineRow } from '../../model/timeline/runs';

/** A step's error code as a sentence, what to do, and the code for support. */
export function StepError({
  code,
  workspace,
  summary,
  definitionKey,
}: Readonly<{
  code: string;
  summary?: string | undefined;
  workspace: AccessibleWorkspace;
  /** The step's type, so an expiry names what expired. */
  definitionKey?: string | undefined;
}>) {
  const copy = describeStepError(code, definitionKey);
  const canOpenConnections = workspace.capabilities.includes('connection:read');
  return (
    <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/[0.05] p-3 text-[0.8rem] leading-relaxed">
      <p className="text-foreground">{summary ?? copy.sentence}</p>
      <p className="mt-1 text-muted-foreground">{copy.advice}</p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <code className="font-mono text-[0.7rem] text-destructive/90">
          {code}
        </code>
        {copy.fix !== undefined && canOpenConnections ? (
          <Link
            to="/w/$workspaceId/connections"
            params={{ workspaceId: workspace.id }}
            className={buttonVariants({ size: 'xs', variant: 'default' })}
          >
            {copy.fix === 'reconnect' ? 'Reconnect' : 'Check connections'}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function StoryEntry({
  entry,
  nowMs,
  workspace,
  errorSummary,
  definitionKey,
}: Readonly<{
  errorSummary?: string | undefined;
  definitionKey?: string | undefined;
  entry: StepStoryEntry;
  nowMs: number;
  workspace: AccessibleWorkspace;
}>) {
  const reason = storyEntryReason(entry);
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2.5 border-t border-surface-ink/6 py-2.5 text-[0.82rem]">
      <StatusGlyph tone={entry.tone} className="mt-0.5" />
      <div className="min-w-0">
        <p className="font-semibold">{storyEntryTitle(entry)}</p>
        <p className="mt-0.5 font-mono text-[0.7rem] text-subtle-foreground">
          {storyEntryMeta(entry, nowMs)}
        </p>
        {entry.kind === 'retry' ? (
          <p className="mt-1.5 text-muted-foreground">
            Pertexo retries this step on its own.
          </p>
        ) : null}
        {reason === undefined ? null : (
          <p className="mt-1.5 text-muted-foreground">{reason}</p>
        )}
        {entry.safeErrorCode === undefined ? null : (
          <StepError
            code={entry.safeErrorCode}
            summary={errorSummary}
            workspace={workspace}
            definitionKey={definitionKey}
          />
        )}
      </div>
    </li>
  );
}

export function StepExecutionHistory({
  row,
  nowMs,
  workspace,
}: Readonly<{
  row: RunTimelineRow;
  nowMs: number;
  workspace: AccessibleWorkspace;
}>) {
  if (row.reused !== undefined)
    return (
      <div className="text-[0.8rem] text-muted-foreground">
        <p>
          This step was not executed here. Its saved output belongs to this run
          and remains available when the source history expires.
        </p>
        <p className="mt-2">
          Originally finished {formatDateTime(row.reused.sourceCompletedAt)}.
          Reused from{' '}
          <Link
            to="/w/$workspaceId/runs/$runId"
            params={{
              workspaceId: workspace.id,
              runId: row.reused.sourceRunId,
            }}
            className="text-foreground underline underline-offset-4"
          >
            run {shortRunId(row.reused.sourceRunId)}
          </Link>
          .
        </p>
      </div>
    );
  return (
    <>
      {row.failureHandling === undefined ? null : (
        <p className="mb-3 text-[0.8rem] text-muted-foreground">
          {failureHandlingLabel(row)}
        </p>
      )}
      {row.story.length === 0 ? (
        <p className="text-[0.8rem] text-muted-foreground">
          {row.status === 'not_started'
            ? 'This step hasn’t started in this run.'
            : 'Nothing recorded yet.'}
        </p>
      ) : (
        <ol className="flex flex-col">
          {row.story.map((entry) => (
            <StoryEntry
              key={entry.id}
              entry={entry}
              nowMs={nowMs}
              workspace={workspace}
              errorSummary={
                entry.kind === 'attempt' &&
                entry.attemptNumber === row.currentAttemptNumber &&
                entry.safeErrorCode === row.safeErrorCode
                  ? row.errorSummary
                  : undefined
              }
              definitionKey={row.definitionKey}
            />
          ))}
        </ol>
      )}
      {row.safeErrorCode !== undefined &&
      !row.story.some((entry) => entry.safeErrorCode !== undefined) ? (
        <StepError
          code={row.safeErrorCode}
          summary={row.errorSummary}
          workspace={workspace}
          definitionKey={row.definitionKey}
        />
      ) : null}
    </>
  );
}

/** The step whose error explains a failed run, for the phone's notice. */
function failureRow(
  status: string,
  rows: readonly RunTimelineRow[],
): (RunTimelineRow & { safeErrorCode: string }) | undefined {
  if (status !== 'failed' && status !== 'timed_out') return undefined;
  const explained = rows.filter(
    (row): row is RunTimelineRow & { safeErrorCode: string } =>
      row.safeErrorCode !== undefined,
  );
  const failed = explained.filter(
    (row) => row.status === 'failed' || row.status === 'timed_out',
  );
  return failed.at(-1) ?? explained.at(-1);
}

/**
 * Phones: why a failed run failed, right under the header, since the step
 * lens only opens on tap there.
 */
export function PhoneFailureNotice({
  run,
  rows,
  workspace,
}: Readonly<{
  run: Readonly<{ status: string }>;
  rows: readonly RunTimelineRow[];
  workspace: AccessibleWorkspace;
}>) {
  const row = failureRow(run.status, rows);
  if (row === undefined) return null;
  return (
    <section aria-label={`Why ${row.label} failed`} className="-mt-3">
      <StepError
        code={row.safeErrorCode}
        workspace={workspace}
        definitionKey={row.definitionKey}
      />
    </section>
  );
}

function failureHandlingLabel(row: RunTimelineRow) {
  if (row.failureHandling?.disposition === 'handled')
    return 'The selected handler finished successfully. This source step remains failed.';
  if (row.handlingInProgress ?? false)
    return 'The selected failure handler is still running. This source step remains failed.';
  return 'The selected handler did not finish successfully. This failure is unhandled.';
}
