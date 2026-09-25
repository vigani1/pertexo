import { Handle, Position } from '@xyflow/react';
import { ArrowRightToLineIcon, PlugIcon, PowerOffIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  StepTile,
  type StepPresentation,
} from '@/features/catalog/presentation.public';
import { cn } from '@/lib/utils';
import type { WorkflowFlowNode } from '../../model/graph-adapter';
import { handleClass } from './node-card-style';

/** Family tile, title and human type: the top of every step card. */
export function CardHeading({
  step,
  title,
  type,
}: Readonly<{ step: StepPresentation; title: string; type: string }>) {
  return (
    <div className="flex items-center gap-2.5">
      <StepTile step={step} />
      <div className="min-w-0">
        <h2 className="truncate text-[0.84rem] leading-tight font-semibold">
          {title}
        </h2>
        <p className="mt-0.5 truncate text-[0.72rem] text-subtle-foreground">
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
 * Marks for steps that aren't in the catalog, need a connection and so on,
 * and for the step whose output is its For each body's result.
 */
export function NodeMarks({
  data,
}: Readonly<{ data: WorkflowFlowNode['data'] }>) {
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
  return marks.length === 0 ? null : (
    <div className="mt-2 flex flex-wrap gap-1.5">{marks}</div>
  );
}

export function Mark({
  tone = 'neutral',
  children,
}: Readonly<{ tone?: 'neutral' | 'warning'; children: ReactNode }>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[0.62rem] leading-none [&_svg]:size-3',
        tone === 'warning'
          ? 'border-warning/30 bg-warning/8 text-warning'
          : 'border-white/6 bg-white/4 text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

/**
 * Labelled ports, one row each: true/false, case-01…, branch-01…, or a
 * loop's `done`. `label` shows a port under a name other than its ID.
 */
export function PortRows({
  title,
  ports,
  type,
  label = (port) => port,
}: Readonly<{
  title: string;
  ports: readonly string[];
  type: 'source' | 'target';
  label?: (port: string) => string;
}>) {
  const output = type === 'source';
  return (
    <ul
      className={cn(
        '-mx-3 mt-2 flex flex-col gap-0.5 border-t border-white/6 pt-1.5',
        output ? 'items-end' : 'items-start',
      )}
      aria-label={output ? 'Outputs' : 'Inputs'}
    >
      {ports.map((port) => (
        <li
          key={port}
          className={cn(
            'relative flex h-4.5 w-full items-center px-3 font-mono text-[0.64rem] text-muted-foreground',
            output ? 'justify-end' : 'justify-start',
          )}
        >
          {label(port)}
          <Handle
            id={port}
            type={type}
            position={output ? Position.Right : Position.Left}
            aria-label={`${title}: ${output ? 'output' : 'input'} ${label(port)}`}
            className={cn(
              handleClass,
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
