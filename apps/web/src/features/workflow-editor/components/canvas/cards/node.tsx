import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import { StatusGlyph } from '@/components/ui/status';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { WorkflowFlowNode } from '../../../model/graph/adapter';
import { CardHeading, IssueBadge, NodeMarks, PortRows } from './parts';
import { cardClassName, cardIdentity, handleClass, nodeLabel } from './style';

/**
 * A step on the canvas: family tile, title and human type (with a summary
 * of its setup), the wired ports of branching steps, then one line of facts
 * and marks for issues, missing connections and steps that are disabled.
 * Only the selected card animates (its scan edge).
 */
export function WorkflowNodeCard({
  id,
  data,
  selected,
}: NodeProps<WorkflowFlowNode>) {
  const { step, title, type } = cardIdentity(data);
  const branchingIn = data.branching.inputs;
  const branchingOut = data.branching.outputs;
  return (
    <article
      data-selected={selected}
      aria-label={nodeLabel(title, type, data.issueCount)}
      className={cardClassName({
        hasIssues: data.issueCount > 0,
        selected,
        disabled: data.disabled,
      })}
    >
      {branchingIn || data.inputPorts[0] === undefined ? null : (
        <Handle
          id={data.inputPorts[0]}
          type="target"
          position={Position.Left}
          role="img"
          aria-label={`${title}: input`}
          className={handleClass}
        />
      )}
      <CardHeading step={step} title={title} type={type} />
      {branchingIn ? (
        <PortRows
          title={title}
          ports={data.inputPorts}
          side="inputs"
          links={data.links.inputs}
        />
      ) : null}
      {branchingOut ? (
        <PortRows
          title={title}
          ports={data.outputPorts}
          side="outputs"
          links={data.links.outputs}
        />
      ) : null}
      <div className={data.failureEligible ? 'pb-4' : undefined}>
        <NodeMarks id={id} data={data} />
      </div>
      {branchingOut || data.outputPorts[0] === undefined ? null : (
        <Handle
          id={data.outputPorts[0]}
          type="source"
          position={Position.Right}
          role="img"
          aria-label={`${title}: output`}
          className={handleClass}
        />
      )}
      {(data.failureEligible ?? false) ? (
        <>
          <Handle
            id={WORKFLOW_FAILURE_PORT}
            type="source"
            position={Position.Right}
            role="img"
            aria-label={`${title}: Failure output`}
            style={{ top: 'calc(100% - 14px)' }}
            className="!size-2.5 !border-destructive !bg-background !border-dashed"
          />
          <span className="pointer-events-none absolute bottom-1 right-3 flex items-center gap-1 rounded bg-card px-1 text-[0.65rem] text-destructive">
            <StatusGlyph tone="failure" className="size-2.5" />
            Failure
          </span>
        </>
      ) : null}
      <IssueBadge count={data.issueCount} />
    </article>
  );
}
