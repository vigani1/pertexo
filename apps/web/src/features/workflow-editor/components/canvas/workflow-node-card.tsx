import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { WorkflowFlowNode } from '../../model/graph-adapter';
import {
  CardHeading,
  IssueBadge,
  NodeMarks,
  PortRows,
} from './node-card-parts';
import {
  cardClassName,
  cardIdentity,
  handleClass,
  nodeLabel,
} from './node-card-style';

/**
 * A step on the canvas: family tile, title and human type (with a summary
 * of its setup), the wired ports of branching steps, then one line of facts
 * and marks for issues, missing connections and steps that are disabled.
 * Only the selected card animates (its scan edge).
 */
export function WorkflowNodeCard({
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
      <NodeMarks data={data} />
      {branchingOut || data.outputPorts[0] === undefined ? null : (
        <Handle
          id={data.outputPorts[0]}
          type="source"
          position={Position.Right}
          aria-label={`${title}: output`}
          className={handleClass}
        />
      )}
      <IssueBadge count={data.issueCount} />
    </article>
  );
}
