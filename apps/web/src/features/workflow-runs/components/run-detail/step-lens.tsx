import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import { Status, StatusGlyph } from '@/components/ui/status';
import { ArtifactDownload } from '@/features/artifacts/public';
import type { ApiClient } from '@/lib/api/client';
import { describeStepError } from '../../model/step-error-copy';
import {
  stepTag,
  storyEntryMeta,
  storyEntryTitle,
} from '../../model/step-copy';
import type { StepStoryEntry } from '../../model/step-replay';
import type { ThreadRow } from '../../model/thread-view';
import { shortRunId } from '../../model/run-list';
import { CopyButton } from '@/components/ui/copy-button';

function LensSection({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 font-sans text-xs font-semibold text-subtle-foreground">
        {title}
      </h3>
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
        {entry.safeErrorCode === undefined ? null : (
          <StepError code={entry.safeErrorCode} workspace={workspace} />
        )}
      </div>
    </li>
  );
}

function StepOutputs({
  row,
  apiClient,
  userId,
  workspace,
}: Readonly<{
  row: ThreadRow;
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>) {
  const canReadArtifacts = workspace.capabilities.includes('artifact:read');
  const files = row.outputs.filter((output) => output.kind === 'artifact');
  const inline = row.outputs.filter((output) => output.kind === 'inline');
  if (row.outputs.length === 0)
    return (
      <p className="text-[0.8rem] text-muted-foreground">
        {row.status === 'running' ||
        row.status === 'waiting' ||
        row.status === 'pending' ||
        row.status === 'ready'
          ? 'Shows up when the step finishes: a result, or a file you can download.'
          : 'This step didn’t report an output.'}
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {canReadArtifacts
        ? files.map((output) => (
            <ArtifactDownload
              key={output.artifactId}
              apiClient={apiClient}
              userId={userId}
              workspaceId={workspace.id}
              artifactId={output.artifactId}
            />
          ))
        : null}
      {files.length > 0 && !canReadArtifacts ? (
        <p className="text-[0.8rem] text-muted-foreground">
          This step produced a file, but your role can’t download files.
        </p>
      ) : null}
      {inline.length > 0 ? (
        <p className="text-[0.8rem] text-muted-foreground">
          This step returned a result. Pertexo keeps it with the attempt, but
          showing it here needs an API endpoint that isn’t available yet.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Everything about one step: its status, the story of its attempts with
 * errors explained, its outputs and, tucked away, its identifiers. The
 * caller renders the step's name as the panel or sheet title.
 */
export function StepLens({
  row,
  nowMs,
  apiClient,
  userId,
  workspace,
}: Readonly<{
  row: ThreadRow | undefined;
  nowMs: number;
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>) {
  if (row === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        Choose a step to see what happened in it.
      </p>
    );
  return (
    <div className="text-sm">
      <p className="text-xs text-subtle-foreground">
        {[
          row.kindLabel,
          row.attempts > 1 ? `attempt ${String(row.attempts)}` : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join(' · ') || 'Step'}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Status tone={row.tone}>{row.statusLabel}</Status>
        <span className="font-mono text-xs text-subtle-foreground">
          {stepTag(row, nowMs)}
        </span>
      </div>
      <LensSection title="What happened">
        {row.story.length === 0 ? (
          <p className="text-[0.8rem] text-muted-foreground">
            {row.status === 'not_started'
              ? 'This step hasn’t started in this run.'
              : 'Nothing recorded yet.'}
          </p>
        ) : (
          <ol className="flex flex-col">
            {row.story.map((entry, index) => (
              <StoryEntry
                key={`${entry.kind}-${entry.startedAt}-${String(index)}`}
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
      </LensSection>
      <LensSection title="Output">
        <StepOutputs
          row={row}
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
        />
      </LensSection>
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
