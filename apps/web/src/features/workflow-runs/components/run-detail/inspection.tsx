import { StepCodeDiagnostics } from './code/diagnostics';
import { StepExecutionHistory } from './execution-history';
export { StepError } from './execution-history';
import type { ReactNode } from 'react';
import { Status } from '@/components/ui/status';
import { stepTag } from '../../model/step-inspection/copy';
import type { RunTimelineRow } from '../../model/timeline/runs';
import { shortRunId } from '../../model/list/runs';
import { CopyButton } from '@/components/ui/copy-button';
import { InfoHint } from '@/components/patterns/guidance/info-hint';
import { StepInputData } from './data/inputs';
import { StepOutputData } from './data/outputs';
import type { RunDataScope } from './data/value';
import { Disclosure } from '@/components/ui/disclosure';

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
        <StepExecutionHistory row={row} nowMs={nowMs} workspace={workspace} />
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
        {row.reused === undefined ? (
          <StepInputData
            row={row}
            rows={rows}
            upstream={upstream}
            scope={scope}
          />
        ) : (
          <p className="text-[0.8rem] text-muted-foreground">
            No input was sent: this step used its saved output.
          </p>
        )}
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
      {row.definitionKey === 'core.code' ? (
        <StepDetailsSection title="Code diagnostics">
          <StepCodeDiagnostics row={row} scope={scope} />
        </StepDetailsSection>
      ) : null}
      <Disclosure
        summary="Details"
        className="mt-6"
        appearance={{ size: 'xs' }}
      >
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
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
      </Disclosure>
    </div>
  );
}
