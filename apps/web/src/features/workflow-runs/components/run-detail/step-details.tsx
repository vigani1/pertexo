import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import { Status, StatusGlyph } from '@/components/ui/status';
import { describeStepError } from '../../model/step-inspection/step-error-copy';
import {
  stepTag,
  storyEntryMeta,
  storyEntryReason,
  storyEntryTitle,
} from '../../model/step-inspection/step-copy';
import type { StepStoryEntry } from '../../model/timeline/step-replay';
import type { RunTimelineRow } from '../../model/timeline/run-timeline-model';
import { shortRunId } from '../../model/list/run-list';
import { CopyButton } from '@/components/ui/copy-button';
import { InfoHint } from '@/components/patterns/guidance/info-hint';
import { StepInputData, StepOutputData, type RunDataScope } from './data';

function StepDetailsSection({
  title,
  hint,
  children,
}: Readonly<{ title: string; hint?: ReactNode; children: ReactNode }>) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-1">
        <h3 className="font-sans text-xs font-semibold text-subtle-foreground">
          {title}
        </h3>
        {hint === undefined ? null : (
          <InfoHint title={title} className="-my-1">
            {hint}
          </InfoHint>
        )}
      </div>
      {children}
    </section>
  );
}

/** A step's error code as a sentence, what to do, and the code for support. */
export function StepError({
  code,
  workspace,
}: Readonly<{ code: string; workspace: AccessibleWorkspace }>) {
  const copy = describeStepError(code);
  const canOpenConnections = workspace.capabilities.includes('connection:read');
  return (
    <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/[0.05] p-3 text-[0.8rem] leading-relaxed">
      <p className="text-foreground">{copy.sentence}</p>
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
}: Readonly<{
  entry: StepStoryEntry;
  nowMs: number;
  workspace: AccessibleWorkspace;
}>) {
  const reason = storyEntryReason(entry);
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2.5 border-t border-white/6 py-2.5 text-[0.82rem]">
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
          <StepError code={entry.safeErrorCode} workspace={workspace} />
        )}
      </div>
    </li>
  );
}

/**
 * Everything about one step: its status, the story of its attempts with
 * errors explained, its outputs and, tucked away, its identifiers. The
 * caller renders the step's name as the panel or sheet title.
 */
export function RunStepDetails({
  row,
  rows,
  upstream,
  nowMs,
  scope,
}: Readonly<{
  row: RunTimelineRow | undefined;
  rows: readonly RunTimelineRow[];
  /** Steps connected into each step; undefined while the version loads. */
  upstream: ReadonlyMap<string, readonly string[]> | undefined;
  nowMs: number;
  scope: RunDataScope;
}>) {
  const { workspace } = scope;
  if (row === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        Choose a step to see what happened in it.
      </p>
    );
  return (
    <div className="text-sm">
      {/* The step's type under a custom name, and which attempt; nothing
          when the title already is the type. */}
      {row.kindLabel === undefined && row.attempts <= 1 ? null : (
        <p className="text-xs text-subtle-foreground">
          {[
            row.kindLabel,
            row.attempts > 1 ? `attempt ${String(row.attempts)}` : undefined,
          ]
            .filter((part): part is string => part !== undefined)
            .join(' · ')}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Status tone={row.tone}>{row.statusLabel}</Status>
        <span className="font-mono text-xs text-subtle-foreground">
          {stepTag(row, nowMs)}
        </span>
      </div>
      <StepDetailsSection title="What happened">
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
              />
            ))}
          </ol>
        )}
        {row.safeErrorCode !== undefined &&
        !row.story.some((entry) => entry.safeErrorCode !== undefined) ? (
          <StepError code={row.safeErrorCode} workspace={workspace} />
        ) : null}
      </StepDetailsSection>
      <StepDetailsSection
        title="Data in"
        hint={
          <>
            <p>
              Exactly what this step received, as it started. Where it came from
              is underneath: the run’s input for the first step, and what the
              steps connected into it returned for the others.
            </p>
            <p>Pertexo keeps run data for 30 days, then deletes it.</p>
          </>
        }
      >
        <StepInputData
          row={row}
          rows={rows}
          upstream={upstream}
          scope={scope}
        />
      </StepDetailsSection>
      <StepDetailsSection
        title="Data out"
        hint={
          <p>
            What this step returned, which the steps after it receive. A file
            shows as a download.
          </p>
        }
      >
        <StepOutputData
          row={row}
          scope={scope}
          title={`Data out of ${row.label}`}
        />
      </StepDetailsSection>
      <details className="group mt-6">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-subtle-foreground outline-none hover:text-foreground focus-ring [&::-webkit-details-marker]:hidden">
          Details
          <ChevronDownIcon
            aria-hidden="true"
            className="size-3.5 transition-transform group-open:rotate-180"
          />
        </summary>
        <dl className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-subtle-foreground">Step ID</dt>
          <dd className="min-w-0">
            <CopyButton
              value={row.nodeId}
              display={row.nodeId}
              label="Copy step ID"
            />
          </dd>
          {row.invocationKey === undefined ? null : (
            <>
              <dt className="text-subtle-foreground">Invocation</dt>
              <dd className="min-w-0">
                <CopyButton
                  value={row.invocationKey}
                  display={row.invocationKey}
                  label="Copy invocation key"
                />
              </dd>
            </>
          )}
          {row.nodeRunId === undefined ? null : (
            <>
              <dt className="text-subtle-foreground">Step run</dt>
              <dd className="min-w-0">
                <CopyButton
                  value={row.nodeRunId}
                  display={shortRunId(row.nodeRunId)}
                  label="Copy step run ID"
                />
              </dd>
            </>
          )}
        </dl>
      </details>
    </div>
  );
}
