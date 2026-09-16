import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import type { WorkflowFlowEdge } from '../../model/graph-adapter';

export function WorkflowEdge({
  markerEnd,
  selected,
  sourcePosition,
  sourceX,
  sourceY,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps<WorkflowFlowEdge>) {
  const [path] = getSmoothStepPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  });
  return (
    <>
      <BaseEdge
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        className="!stroke-border !stroke-[3.5]"
      />
      <BaseEdge
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        className={cn(
          '!stroke-muted-foreground/50 !stroke-[1.5] transition-colors motion-reduce:transition-none',
          selected && '!stroke-primary',
        )}
      />
    </>
  );
}
