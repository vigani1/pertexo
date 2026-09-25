import { Handle, Position, type NodeProps } from '@xyflow/react';
import { RepeatIcon } from 'lucide-react';
import type { LoopSummary, WorkflowFlowNode } from '../../model/graph-adapter';
import {
  CardHeading,
  IssueBadge,
  Mark,
  NodeMarks,
  PortRows,
} from './node-card-parts';
import {
  cardClassName,
  cardIdentity,
  handleClass,
  nodeLabel,
} from './node-card-style';

/** Body steps listed on the card before the rest are counted. */
const SHOWN_BODY_STEPS = 3;

const donePort = () => 'done';

/**
 * A For each step as a container (ADR 020): its body runs once per item and
 * sits inside the card, fed by `item` and `ordinal` and ending in `result`.
 * The body never connects to outer steps; the one outer output, shown as
 * `done`, continues after every item has finished. Chips show how many
 * items it accepts and how many run at a time.
 */
export function ForEachNodeCard({
  data,
  selected,
}: NodeProps<WorkflowFlowNode>) {
  const { step, title, type } = cardIdentity(data);
  const input = data.inputPorts[0];
  return (
    <article
      data-selected={selected}
      aria-label={nodeLabel(title, type, data.issueCount)}
      className={cardClassName(
        {
          hasIssues: data.issueCount > 0,
          selected,
          disabled: data.disabled,
        },
        'w-72',
      )}
    >
      {input === undefined ? null : (
        <Handle
          id={input}
          type="target"
          position={Position.Left}
          aria-label={`${title}: input`}
          className={handleClass}
        />
      )}
      <CardHeading step={step} title={title} type={type} />
      <NodeMarks data={data} />
      <LoopBody loop={data.loop} />
      {data.loop === null ? null : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Mark>
            <RepeatIcon aria-hidden="true" />
            up to {data.loop.maxIterations}{' '}
            {data.loop.maxIterations === 1 ? 'item' : 'items'}
          </Mark>
          <Mark>{data.loop.maxConcurrency} at a time</Mark>
        </div>
      )}
      <PortRows
        title={title}
        ports={data.outputPorts}
        type="source"
        label={donePort}
      />
      <IssueBadge count={data.issueCount} />
    </article>
  );
}

function LoopBody({ loop }: Readonly<{ loop: LoopSummary | null }>) {
  if (loop === null)
    return (
      <p className="mt-2.5 rounded-md border border-dashed border-white/12 px-2 py-2 text-[0.7rem] leading-snug text-subtle-foreground">
        No body yet. Steps inside a For each run once per item.
      </p>
    );
  const shown = loop.steps.slice(0, SHOWN_BODY_STEPS);
  const hidden = loop.steps.length - shown.length;
  return (
    <section
      aria-label="Body, runs once per item"
      className="mt-2.5 rounded-md border border-dashed border-secondary/35 bg-secondary/[0.04] px-2 pt-1.5 pb-2"
    >
      <div className="flex items-center justify-between gap-2 font-mono text-[0.6rem] text-subtle-foreground">
        <span>
          <span className="text-secondary">body</span> ←{' '}
          {loop.inputs.join(' · ')}
        </span>
        <span>{loop.outputs.join(' · ')} →</span>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {shown.map((bodyStep) => (
          <li
            key={bodyStep.id}
            className="truncate rounded-sm border border-white/6 bg-white/4 px-1.5 py-1 text-[0.7rem]"
          >
            {bodyStep.title}
          </li>
        ))}
        {hidden > 0 ? (
          <li className="px-1.5 font-mono text-[0.62rem] text-subtle-foreground">
            +{hidden} more {hidden === 1 ? 'step' : 'steps'}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
