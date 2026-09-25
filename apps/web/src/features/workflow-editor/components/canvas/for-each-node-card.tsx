import { Handle, Position, type NodeProps } from '@xyflow/react';
import { PlusIcon, RepeatIcon } from 'lucide-react';
import { use } from 'react';
import { StatusGlyph } from '@/components/ui/status';
import { LOOP_FRAME } from '../../model/body-layout';
import type { BodyIssue } from '../../model/body-rules';
import { CanvasActionsContext } from '../../model/canvas-actions-context';
import type { WorkflowFlowNode } from '../../model/graph-adapter';
import { BODY_PORTS } from '../../model/graph-scopes';
import { CardHeading, IssueBadge, Mark, NodeMarks } from './node-card-parts';
import {
  cardClassName,
  cardIdentity,
  handleClass,
  nodeLabel,
} from './node-card-style';

const noIssues: readonly BodyIssue[] = Object.freeze([]);
const noBody = Object.freeze({
  width: LOOP_FRAME.minWidth,
  height: LOOP_FRAME.minHeight,
  issues: noIssues,
});

/**
 * A For each step as a container (ADR 020): its body runs once per item.
 * The body's steps are canvas steps of their own, drawn inside the body
 * area, fed by `item` and `ordinal` and ending in `result`; they never
 * connect to steps outside it. The one outer output, `done`, continues
 * after every item has finished. The footer shows the bounds, what the
 * body still needs, and Add step for the body.
 */
export function ForEachNodeCard({
  id,
  data,
  selected,
}: NodeProps<WorkflowFlowNode>) {
  const { step, title, type } = cardIdentity(data);
  const { editable, addToBody } = use(CanvasActionsContext);
  const input = data.inputPorts[0];
  const output = data.outputPorts[0];
  const body = data.body ?? noBody;
  const stepCount = data.loop?.steps.length ?? 0;
  return (
    <article
      data-selected={selected}
      aria-label={loopLabel(
        nodeLabel(title, type, data.issueCount),
        body.issues.length,
      )}
      className={cardClassName(
        {
          hasIssues: data.issueCount > 0,
          selected,
          disabled: data.disabled,
        },
        'w-auto p-0',
      )}
      style={{ width: body.width + 2 * LOOP_FRAME.inset }}
    >
      <div
        className="relative flex items-center gap-2 px-3"
        style={{ height: LOOP_FRAME.header }}
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
        <div className="min-w-0 flex-1">
          <CardHeading step={step} title={title} type={type} />
        </div>
        {output === undefined ? null : (
          <>
            <span className="font-mono text-[0.64rem] text-muted-foreground">
              done
            </span>
            <Handle
              id={output}
              type="source"
              position={Position.Right}
              aria-label={`${title}: output done`}
              className={handleClass}
            />
          </>
        )}
      </div>
      <section aria-label="Body, runs once per item">
        <div
          className="flex items-center justify-between px-3 font-mono text-[0.6rem] text-subtle-foreground"
          style={{ height: LOOP_FRAME.label }}
        >
          <span>
            <span className="text-secondary">body</span> ←{' '}
            {(data.loop?.inputs ?? BODY_PORTS.inputs).join(' · ')}
          </span>
          <span>
            {(data.loop?.outputs ?? BODY_PORTS.outputs).join(' · ')} →
          </span>
        </div>
        <div
          data-for-each-body
          className="relative rounded-md border border-dashed border-secondary/35 bg-secondary/[0.04]"
          style={{
            marginInline: LOOP_FRAME.inset,
            width: body.width,
            height: body.height,
          }}
        >
          {stepCount === 0 ? (
            <p className="absolute inset-x-4 top-4 text-[0.7rem] leading-snug text-subtle-foreground">
              No steps yet. Steps inside a For each run once per item.
            </p>
          ) : null}
        </div>
      </section>
      <div className="flex flex-col gap-1.5 px-3 pt-0.5 pb-2.5">
        <NodeMarks data={data} />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {data.loop === null ? null : (
            <>
              <Mark>
                <RepeatIcon aria-hidden="true" />
                up to {data.loop.maxIterations}{' '}
                {data.loop.maxIterations === 1 ? 'item' : 'items'}
              </Mark>
              <Mark>{data.loop.maxConcurrency} at a time</Mark>
            </>
          )}
          {editable ? (
            <button
              type="button"
              aria-label={`Add a step to ${title}’s body`}
              className="nodrag nopan ml-auto inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[0.7rem] font-medium text-accent-foreground outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3"
              onClick={(event) => {
                event.stopPropagation();
                addToBody(id, event.currentTarget);
              }}
              onKeyDown={(event) => {
                // Keep Enter and Space for the button, not the card's selection.
                if (event.key === 'Enter' || event.key === ' ')
                  event.stopPropagation();
              }}
            >
              <PlusIcon aria-hidden="true" />
              Add step
            </button>
          ) : null}
        </div>
        {body.issues.length === 0 ? null : (
          <ul aria-label="What the body needs" className="flex flex-col gap-1">
            {body.issues.map((issue) => (
              <li
                key={issue.code}
                className="flex items-start gap-1.5 text-[0.68rem] leading-snug text-warning"
              >
                <StatusGlyph tone="attention" className="mt-px shrink-0" />
                {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <IssueBadge count={data.issueCount} />
    </article>
  );
}

function loopLabel(label: string, bodyIssues: number): string {
  if (bodyIssues === 0) return label;
  return `${label}, body needs ${String(bodyIssues)} ${bodyIssues === 1 ? 'fix' : 'fixes'}`;
}
