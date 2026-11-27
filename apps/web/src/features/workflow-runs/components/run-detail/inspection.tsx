import type { WorkflowCallSummary } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { dataTableIdentity, matchesDataTableIdentity } from '@pertexo/node-sdk';
import { tablesQuery } from '@/features/data-tables/public';
import { AgentActivity } from './timeline/agent-activity';
import {
  AGENT_STEP,
  CLASSIFY_STEP,
  GUARDRAILS_STEP,
} from '@pertexo/workflow-model';
import {
  StepCodeDiagnostics,
  StepGuardrailsDiagnostics,
  StepModelUsage,
} from './run-diagnostics';
import { StepExecutionHistory } from './execution-history';
export { StepError } from './execution-history';
import type { ReactNode } from 'react';
import { Status } from '@/components/patterns/status/status-mark';
import { stepTag } from '../../model/step-inspection/copy';
import type { RunTimelineRow } from '../../model/timeline/runs';
import { shortRunId } from '../../model/list/runs';
import { CopyButton } from '@/components/ui/copy-button';
import { InfoHint } from '@/components/patterns/guidance/info-hint';
import { StepInputData } from './data/inputs';
import { StepOutputData } from './data/outputs';
import type { RunDataScope } from './data/value';
import { Disclosure } from '@/components/ui/disclosure';
import { DATA_RETENTION_DAYS } from '@pertexo/workflow-model';
import { formatCount } from '@/lib/format/count';

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
  onSelectStep,
  calls,
}: Readonly<{
  calls?: readonly WorkflowCallSummary[] | undefined;
  onSelectStep?: (key: string) => void;
  row: RunTimelineRow | undefined;
  rows: readonly RunTimelineRow[];
  /** Steps connected into each step; undefined while the version loads. */
  upstream: ReadonlyMap<string, readonly string[]> | undefined;
  nowMs: number;
  scope: RunDataScope;
}>) {
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
      <FindRowsTable binding={row.findRowsTable} scope={scope} />
      <StepHistory row={row} scope={scope} nowMs={nowMs} />
      {onSelectStep === undefined ? null : (
        <AgentActivity
          parentKey={row.key}
          {...(calls === undefined ? {} : { calls })}
          rows={rows}
          nowMs={nowMs}
          scope={scope}
          onSelectStep={onSelectStep}
        />
      )}
      {row.definitionKey === GUARDRAILS_STEP.key ? (
        <StepDetailsSection title="Data in">
          <p className="text-label text-muted-foreground">
            Guardrails keeps the outcome, safe categories and any model usage.
          </p>
        </StepDetailsSection>
      ) : (
        <StepInputs row={row} rows={rows} upstream={upstream} scope={scope} />
      )}
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
      {row.definitionKey === GUARDRAILS_STEP.key &&
      row.status === 'succeeded' &&
      row.reused === undefined &&
      row.nodeRunId !== undefined ? (
        <StepDetailsSection title="Guardrails diagnostics">
          <StepGuardrailsDiagnostics
            scope={scope}
            nodeRunId={row.nodeRunId}
            attemptNumber={row.currentAttemptNumber}
          />
        </StepDetailsSection>
      ) : null}
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

function FindRowsTable({
  binding,
  scope,
}: Readonly<{
  binding: RunTimelineRow['findRowsTable'];
  scope: RunDataScope;
}>) {
  const query = useQuery({
    ...tablesQuery({
      apiClient: scope.apiClient,
      userId: scope.userId,
      workspaceId: scope.workspace.id,
    }),
    enabled: binding !== undefined,
  });
  if (binding === undefined) return null;
  const identity = dataTableIdentity(binding);
  const table = query.data?.tables.find((table) =>
    matchesDataTableIdentity(table, identity),
  );
  return (
    <p className="mt-2 text-xs text-subtle-foreground">
      Workspace table {table?.name ?? binding.table}
    </p>
  );
}

function StepInputs({
  row,
  rows,
  upstream,
  scope,
}: Readonly<{
  row: RunTimelineRow;
  rows: readonly RunTimelineRow[];
  upstream: ReadonlyMap<string, readonly string[]> | undefined;
  scope: RunDataScope;
}>) {
  const isAgent =
    row.definitionKey === AGENT_STEP.key && row.agentWork === undefined;
  const mappedInput = isAgent || row.agentWork?.work.kind === 'model_turn';
  let content: ReactNode;
  if (row.reused !== undefined) {
    content = (
      <p className="text-label text-muted-foreground">
        No input was sent: this step used its saved output.
      </p>
    );
  } else if (isAgent) {
    content = (
      <p className="text-label text-muted-foreground">
        Open a model turn to see the task and input it received.
      </p>
    );
  } else {
    content = (
      <StepInputData row={row} rows={rows} upstream={upstream} scope={scope} />
    );
  }
  return (
    <StepDetailsSection
      title={mappedInput ? 'Mapped input' : 'Data in'}
      hint={
        mappedInput ? (
          <p>The task and input supplied by this step’s mappings.</p>
        ) : (
          <>
            <p>
              Exactly what this step received, as it started. Where it came from
              is underneath: the run’s input for the first step, and what the
              steps connected into it returned for the others.
            </p>
            <p>
              Pertexo keeps run data for{' '}
              {formatCount(DATA_RETENTION_DAYS.runDetails, 'day')}, then deletes
              it.
            </p>
          </>
        )
      }
    >
      {content}
    </StepDetailsSection>
  );
}

function StepHistory({
  row,
  scope,
  nowMs,
}: Readonly<{
  row: RunTimelineRow;
  scope: RunDataScope;
  nowMs: number;
}>) {
  const { nodeRunId } = row;
  return (
    <StepDetailsSection title="What happened">
      <StepExecutionHistory
        row={row}
        nowMs={nowMs}
        workspace={scope.workspace}
        {...((row.definitionKey === 'ai.model' ||
          row.definitionKey === CLASSIFY_STEP.key ||
          row.definitionKey === GUARDRAILS_STEP.key ||
          row.agentWork?.work.kind === 'model_turn') &&
        nodeRunId !== undefined
          ? {
              attemptUsage: (attemptNumber: number) => (
                <StepModelUsage
                  scope={scope}
                  nodeRunId={nodeRunId}
                  attemptNumber={attemptNumber}
                  optional={row.definitionKey === GUARDRAILS_STEP.key}
                />
              ),
            }
          : {})}
      />
    </StepDetailsSection>
  );
}
