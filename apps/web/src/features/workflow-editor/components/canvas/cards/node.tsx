import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import { StatusMark } from '@/components/patterns/status/status-mark';
import {
  Handle,
  Position,
  type NodeProps,
  useUpdateNodeInternals,
} from '@xyflow/react';
import { useLayoutEffect } from 'react';
import type { WorkflowFlowNode } from '../../../model/graph/adapter';
import {
  CardHeading,
  IssueBadge,
  NodeMarks,
  PortRows,
  StepRunLine,
} from './parts';
import { cardClassName, cardIdentity, handleClass } from './style';

/**
 * A step on the canvas: family tile, title and human type (with a summary
 * of its setup), the wired ports of branching steps, then one line of facts
 * and marks for issues, missing connections and steps that are disabled.
 * Under the card, what the step did in the last run.
 */
export function WorkflowNodeCard({
  id,
  data,
  selected,
}: NodeProps<WorkflowFlowNode>) {
  const { step, title, type } = cardIdentity(data);
  const branchingIn = data.branching.inputs;
  const branchingOut =
    data.branching.outputs || data.outputPortLabels !== undefined;
  const categoryPortOrder =
    data.outputPortLabels === undefined
      ? undefined
      : data.outputPorts.join(',');
  const updateNodeInternals = useUpdateNodeInternals();
  // Reordering categories can move handles without resizing the card.
  useLayoutEffect(() => {
    if (categoryPortOrder !== undefined) updateNodeInternals(id);
  }, [categoryPortOrder, id, updateNodeInternals]);
  return (
    <article
      data-selected={selected}
      className={cardClassName({
        selected,
        disabled: data.disabled,
        passedBy: data.lastRun?.kind === 'not-taken',
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
          labels={data.outputPortLabels}
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
          <span className="pointer-events-none absolute bottom-1 right-3 flex items-center gap-1 rounded bg-card px-1 text-micro text-destructive">
            <StatusMark display="mark" tone="failure" className="size-2.5" />
            Failure
          </span>
        </>
      ) : null}
      <IssueBadge count={data.issueCount} />
      <StepRunLine result={data.lastRun} />
    </article>
  );
}
