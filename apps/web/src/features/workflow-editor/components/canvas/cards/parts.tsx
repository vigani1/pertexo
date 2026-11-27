import { StatusMark } from '@/components/patterns/status/status-mark';
import { describeNodeStatus } from '@/features/workflow-runs/public';
import { Handle, Position } from '@xyflow/react';
import {
  ArrowRightToLineIcon,
  MessageSquareIcon,
  PinIcon,
  PlugIcon,
  PowerOffIcon,
} from 'lucide-react';
import { use, type ReactNode } from 'react';
import {
  StepTile,
  TimedOutGlyph,
} from '@/features/catalog/catalog-views.public';
import { type StepPresentation, portName } from '@/features/catalog/public';
import { TIMED_OUT_PORT } from '@pertexo/workflow-model';
import { sampleStateLabel } from '@/features/workflow-testing/public';
import { formatByteLength } from '@/lib/format/bytes';
import { cn } from '@/lib/class-names';
import type { WorkflowFlowNode } from '../../../model/graph/adapter';
import { portLinkLabel } from '../../../model/step-card';
import { StepDiscussionsContext } from '../../../model/state/discussions';
import { handleClass } from './style';
import { pluralWord } from '@/lib/format/count';

/**
 * Family tile, title and human type: the top of every step card. Sized so
 * the canvas stays readable at the editor's lowest fitted zoom.
 */
export function CardHeading({
  step,
  title,
  type,
}: Readonly<{ step: StepPresentation; title: string; type: string }>) {
  return (
    <div className="flex items-center gap-3">
      <StepTile step={step} size="lg" />
      <div className="min-w-0">
        <h2 className="truncate text-base leading-tight font-semibold">
          {title}
        </h2>
        <p className="mt-0.5 truncate text-label text-subtle-foreground">
          {type}
        </p>
      </div>
    </div>
  );
}

/**
 * What the step did in the workflow's last run, written under its card:
 * how long it took, the error code and tries of a failure, or that the run
 * never reached it. Outside the card's box, so it never resizes the card.
 */
export function StepRunLine({
  result,
}: Readonly<{ result: WorkflowFlowNode['data']['lastRun'] }>) {
  if (result === undefined) return null;
  return (
    <p className="pointer-events-none absolute top-full left-1 mt-2 flex items-center gap-1.5 font-mono text-caption whitespace-nowrap text-subtle-foreground">
      <StepRunWords result={result} />
    </p>
  );
}

function StepRunWords({
  result,
}: Readonly<{ result: NonNullable<WorkflowFlowNode['data']['lastRun']> }>) {
  if (result.kind === 'not-taken') return <>not taken in the last run</>;
  if (result.kind === 'failed')
    return (
      <>
        <StatusMark tone="failure" display="mark" label="Failed" />
        <span className="text-destructive">{result.code ?? 'failed'}</span>
        {result.tries === null ? null : <span>· {result.tries}</span>}
      </>
    );
  const look = describeNodeStatus(result.status);
  return (
    <>
      <StatusMark tone={look.tone} display="mark" label={look.label} />
      {result.status === 'succeeded' ? null : <span>{look.label}</span>}
      {result.detail === null ? null : <span>{result.detail}</span>}
    </>
  );
}

export function IssueBadge({ count }: Readonly<{ count: number }>) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className="absolute -top-2.5 -right-2.5 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1 font-mono text-caption font-bold text-background ring-2 ring-background"
    >
      {count}
    </span>
  );
}

/**
 * Facts from real data, then any marks. Facts: the output size
 * of the step's last passed test here and whether the latest check found
 * nothing wrong with it. Marks: the step whose output is its For each
 * body's result, steps that aren't in the catalog, need a connection, are
 * disabled or deprecated.
 */
export function NodeMarks({
  id,
  data,
}: Readonly<{ id: string; data: WorkflowFlowNode['data'] }>) {
  const discussions = use(StepDiscussionsContext).get(id) ?? 0;
  const facts: ReactNode[] = [];
  if (data.testStatus !== undefined) {
    const look = describeNodeStatus(data.testStatus);
    facts.push(
      <StatusMark key="workflow-test" tone={look.tone}>
        Test · {look.label}
      </StatusMark>,
    );
  }
  if (data.testOutputBytes !== undefined)
    facts.push(
      <Mark key="test">
        {formatByteLength(data.testOutputBytes)} last test
      </Mark>,
    );
  const marks = stepMarks(data);
  if (discussions > 0)
    marks.push(
      <Mark key="discussions">
        <MessageSquareIcon aria-hidden="true" />
        {discussions} open {pluralWord(discussions, 'discussion')}
      </Mark>,
    );
  if (facts.length === 0 && marks.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-col gap-1.5">
      {facts.length === 0 ? null : (
        // Facts wrap rather than squeeze: a status word can't shrink.
        <div className="flex flex-wrap items-center gap-1.5">{facts}</div>
      )}
      {marks.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">{marks}</div>
      )}
    </div>
  );
}

function stepMarks(data: WorkflowFlowNode['data']): ReactNode[] {
  const marks: ReactNode[] = [];
  if (data.sampleState !== undefined)
    marks.push(
      <Mark
        key="sample"
        tone={data.sampleState === 'pinned' ? 'neutral' : 'warning'}
      >
        <PinIcon aria-hidden="true" />
        {sampleStateLabel[data.sampleState]}
      </Mark>,
    );
  if (data.bodyResult)
    marks.push(
      <Mark key="result">
        <ArrowRightToLineIcon aria-hidden="true" />
        Gives the result
      </Mark>,
    );
  if (data.unsupported)
    marks.push(<Mark key="unsupported">Not in catalog</Mark>);
  if (data.missingConnections > 0)
    marks.push(
      <Mark key="connection" tone="warning">
        <PlugIcon aria-hidden="true" />
        Needs a connection
      </Mark>,
    );
  if (data.disabled)
    marks.push(
      <Mark key="disabled">
        <PowerOffIcon aria-hidden="true" />
        Disabled
      </Mark>,
    );
  return marks;
}

const markTones = {
  neutral: 'border-surface-ink/8 bg-surface-ink/4 text-muted-foreground',
  success: 'border-success/20 bg-success/6 text-success',
  warning: 'border-warning/30 bg-warning/8 text-warning',
} as const;

export function Mark({
  tone = 'neutral',
  children,
}: Readonly<{ tone?: keyof typeof markTones; children: ReactNode }>) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1 truncate rounded-[0.3125rem] border px-1.5 py-[0.1875rem] font-mono text-label leading-none [&_svg]:size-3.5 [&_svg]:shrink-0',
        markTones[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * A branching step's ports, one labelled row each, as they're wired:
 * "true → Ask finance", "branch-02 ← Pull incidents", or the bare port
 * while nothing is linked. Handles sit on the card's edge beside them.
 * Timed out keeps its amber hourglass, apart from success and failure.
 */
export function PortRows({
  title,
  ports,
  side,
  links,
  labels,
}: Readonly<{
  title: string;
  ports: readonly string[];
  side: 'inputs' | 'outputs';
  labels?: Readonly<Record<string, string | undefined>> | undefined;
  links: Readonly<Record<string, readonly string[]>>;
}>) {
  const output = side === 'outputs';
  return (
    <ul
      className="mt-2.5 flex flex-col gap-1.5"
      aria-label={output ? 'Outputs' : 'Inputs'}
    >
      {ports.map((port) => {
        const timedOut = output && port === TIMED_OUT_PORT;
        return (
          <li key={port} className="relative flex min-w-0 items-center">
            <Mark tone={timedOut ? 'warning' : 'neutral'}>
              {timedOut ? <TimedOutGlyph className="size-3.5" /> : null}
              {portLinkLabel(port, side, links[port], labels?.[port])}
            </Mark>
            <Handle
              id={port}
              type={output ? 'source' : 'target'}
              position={output ? Position.Right : Position.Left}
              role="img"
              aria-label={`${title}: ${output ? 'output' : 'input'} ${labels?.[port] ?? portName(port)}`}
              className={cn(
                handleClass,
                output ? '!-right-3' : '!-left-3',
                port === 'false' || port === 'default'
                  ? '!border-secondary'
                  : undefined,
                timedOut && '!border-warning !ring-1 !ring-warn-soft',
              )}
            />
          </li>
        );
      })}
    </ul>
  );
}
