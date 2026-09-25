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
 * A step on the canvas: family tile, title and human type, the port labels
 * of branching steps, and marks for issues, missing connections and steps
 * that are disabled. Only the selected card animates (its scan edge).
 */
export function WorkflowNodeCard({
  data,
  selected,
}: NodeProps<WorkflowFlowNode>) {
  const { step, title, type } = cardIdentity(data);
  const branchingIn = data.inputPorts.length > 1;
  const branchingOut = data.outputPorts.length > 1;
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
      <IssueBadge count={data.issueCount} />
    </article>
  );
}
