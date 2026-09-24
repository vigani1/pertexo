import { Handle, Position, type NodeProps } from '@xyflow/react';
import { PlugIcon, PowerOffIcon, RepeatIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  describeStep,
  familyWord,
  StepTile,
} from '@/features/catalog/presentation.public';
import { cn } from '@/lib/utils';
import type { WorkflowFlowNode } from '../../model/graph-adapter';

const handleClass =
  '!size-2.5 !border-[1.5px] !border-primary !bg-background !shadow-[0_0_8px_color-mix(in_srgb,var(--primary)_50%,transparent)]';

/**
 * A step on the canvas: family tile, title and human type, the port labels
 * of branching steps, and marks for issues, missing connections and steps
 * that are disabled. Only the selected card animates (its scan edge).
 */
export function WorkflowNodeCard({
  data,
  selected,
}: NodeProps<WorkflowFlowNode>) {
  const step = describeStep(
    data.definitionKey,
    data.family === 'unknown' ? undefined : data.family,
  );
  const title = data.label ?? step.name;
  const type = data.label === undefined ? familyWord(step.family) : step.name;
  const branchingIn = data.inputPorts.length > 1;
  const branchingOut = data.outputPorts.length > 1;
  return (
    <article
      data-selected={selected}
      aria-label={`${title}, ${type}${data.issueCount > 0 ? `, ${String(data.issueCount)} issues` : ''}`}
      className={cn(
        'relative w-56 rounded-lg border border-white/9 border-t-white/15 bg-[linear-gradient(160deg,rgb(255_255_255/5.5%),rgb(255_255_255/1.5%)),var(--card)] px-3 py-2.5 text-card-foreground shadow-[0_18px_44px_-18px_rgb(0_0_0/90%)] transition-[border-color,box-shadow,opacity] duration-150 motion-reduce:transition-none',
        data.issueCount > 0 &&
          'border-destructive/50 shadow-[0_0_0_1px_color-mix(in_srgb,var(--destructive)_20%,transparent),0_0_26px_-6px_color-mix(in_srgb,var(--destructive)_45%,transparent)]',
        selected &&
          'border-primary/55 shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_25%,transparent),0_0_30px_-4px_color-mix(in_srgb,var(--primary)_35%,transparent)]',
        selected &&
          'after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[inherit] after:border after:border-transparent after:bg-[linear-gradient(90deg,transparent,var(--primary),transparent)_border-box] after:bg-[length:240%_100%] after:[mask-composite:exclude] after:[mask:linear-gradient(#fff_0_0)_padding-box,linear-gradient(#fff_0_0)] motion-safe:after:animate-[workflow-node-scan_3s_linear_infinite]',
        data.disabled && 'opacity-55',
      )}
    >
      {branchingIn || data.inputPorts[0] === undefined ? null : (
        <Handle
          id={data.inputPorts[0]}
          type="target"
          position={Position.Left}
          aria-label={`${title}: input`}
          className={handleClass}
        />
      )}
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
      <NodeMarks data={data} />
      {branchingIn ? (
        <PortRows title={title} ports={data.inputPorts} type="target" />
      ) : null}
      {branchingOut ? (
        <PortRows title={title} ports={data.outputPorts} type="source" />
      ) : null}
      {branchingOut || data.outputPorts[0] === undefined ? null : (
        <Handle
          id={data.outputPorts[0]}
          type="source"
          position={Position.Right}
          aria-label={`${title}: output`}
          className={handleClass}
        />
      )}
      {data.issueCount > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -top-2.5 -right-2.5 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1 font-mono text-[0.68rem] font-bold text-background shadow-[0_0_0_3px_var(--background)]"
        >
          {data.issueCount}
        </span>
      ) : null}
    </article>
  );
}

function NodeMarks({ data }: Readonly<{ data: WorkflowFlowNode['data'] }>) {
  const marks: ReactNode[] = [];
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
  if (data.loop !== null)
    marks.push(
      <Mark key="loop">
        <RepeatIcon aria-hidden="true" />
        up to {data.loop.maxIterations} · {data.loop.maxConcurrency} at once
      </Mark>,
    );
  return marks.length === 0 ? null : (
    <div className="mt-2 flex flex-wrap gap-1.5">{marks}</div>
  );
}

function Mark({
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

/** Labelled ports for branching steps: true/false, case-01…, branch-01…. */
function PortRows({
  title,
  ports,
  type,
}: Readonly<{
  title: string;
  ports: readonly string[];
  type: 'source' | 'target';
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
          {port}
          <Handle
            id={port}
            type={type}
            position={output ? Position.Right : Position.Left}
            aria-label={`${title}: ${output ? 'output' : 'input'} ${port}`}
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
