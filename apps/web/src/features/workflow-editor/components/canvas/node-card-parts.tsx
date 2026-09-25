import { Handle, Position } from '@xyflow/react';
import {
  ArrowRightToLineIcon,
  CheckIcon,
  PlugIcon,
  PowerOffIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  StepTile,
  type StepPresentation,
} from '@/features/catalog/presentation.public';
import { formatByteLength } from '@/lib/format-bytes';
import { cn } from '@/lib/utils';
import type { WorkflowFlowNode } from '../../model/graph-adapter';
import { portLinkLabel } from '../../model/step-card';
import { handleClass } from './node-card-style';

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
        <p className="mt-0.5 truncate text-[0.8125rem] text-subtle-foreground">
          {type}
        </p>
      </div>
    </div>
  );
}

export function IssueBadge({ count }: Readonly<{ count: number }>) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className="absolute -top-2.5 -right-2.5 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1 font-mono text-[0.68rem] font-bold text-background shadow-[0_0_0_3px_var(--background)]"
    >
      {count}
    </span>
  );
}

/**
 * One line of facts from real data, then any marks. Facts: the output size
 * of the step's last passed test here and whether the latest check found
 * nothing wrong with it. Marks: the step whose output is its For each
 * body's result, steps that aren't in the catalog, need a connection, are
 * disabled or deprecated.
 */
export function NodeMarks({
  data,
}: Readonly<{ data: WorkflowFlowNode['data'] }>) {
  const facts: ReactNode[] = [];
  if (data.testOutputBytes !== undefined)
    facts.push(
      <Mark key="test">
        {formatByteLength(data.testOutputBytes)} last test
      </Mark>,
    );
  if (data.checked && data.issueCount === 0 && !data.unsupported)
    facts.push(
      <Mark key="valid" tone="success">
        <CheckIcon aria-hidden="true" />
        valid
      </Mark>,
    );
  const marks = stepMarks(data);
  if (facts.length === 0 && marks.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-col gap-1.5">
      {facts.length === 0 ? null : (
        <div className="flex min-w-0 gap-1.5 [&>*:first-child]:min-w-0 [&>*:first-child]:shrink">
          {facts}
        </div>
      )}
      {marks.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">{marks}</div>
      )}
    </div>
  );
}

function stepMarks(data: WorkflowFlowNode['data']): ReactNode[] {
  const marks: ReactNode[] = [];
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
  if (
    data.lifecycle === 'deprecated' ||
    data.lifecycle === 'migration_required'
  )
    marks.push(
      <Mark key="lifecycle" tone="warning">
        {data.lifecycle === 'deprecated' ? 'Deprecated' : 'Needs migration'}
      </Mark>,
    );
  return marks;
}

const markTones = {
  neutral: 'border-white/8 bg-white/4 text-muted-foreground',
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
        'inline-flex max-w-full shrink-0 items-center gap-1 truncate rounded-[0.3125rem] border px-1.5 py-[0.1875rem] font-mono text-[0.75rem] leading-none [&_svg]:size-3.5 [&_svg]:shrink-0',
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
 * while nothing is connected. Handles sit on the card's edge beside them.
 */
export function PortRows({
  title,
  ports,
  side,
  links,
}: Readonly<{
  title: string;
  ports: readonly string[];
  side: 'inputs' | 'outputs';
  links: Readonly<Record<string, readonly string[]>>;
}>) {
  const output = side === 'outputs';
  return (
    <ul
      className="mt-2.5 flex flex-col gap-1.5"
      aria-label={output ? 'Outputs' : 'Inputs'}
    >
      {ports.map((port) => (
        <li key={port} className="relative flex min-w-0 items-center">
          <Mark>{portLinkLabel(port, side, links[port])}</Mark>
          <Handle
            id={port}
            type={output ? 'source' : 'target'}
            position={output ? Position.Right : Position.Left}
            aria-label={`${title}: ${output ? 'output' : 'input'} ${port}`}
            className={cn(
              handleClass,
              output ? '!-right-3' : '!-left-3',
              port === 'false' || port === 'default'
                ? '!border-secondary'
                : undefined,
            )}
          />
        </li>
      ))}
    </ul>
  );
}
