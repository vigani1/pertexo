import type { CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';

export function WorkflowPortHandle({
  id,
  label,
  type,
  top,
}: Readonly<{
  id: string;
  label: string;
  type: 'source' | 'target';
  top: CSSProperties['top'];
}>) {
  const input = type === 'target';
  return (
    <Handle
      id={id}
      type={type}
      position={input ? Position.Left : Position.Right}
      style={{ top }}
      aria-label={`${input ? 'Input' : 'Output'} ${label}`}
      title={`${input ? 'Input' : 'Output'}: ${label}`}
      className="!size-3 !border !border-primary/60 !bg-primary !shadow-[0_0_9px_rgb(0_229_255/48%)]"
    />
  );
}
