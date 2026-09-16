import type { ComponentType } from 'react';
import {
  BoxIcon,
  BracesIcon,
  CheckCircle2Icon,
  GitBranchIcon,
  PlayIcon,
  RadioTowerIcon,
  type LucideProps,
} from 'lucide-react';
import type { NodeProps } from '@xyflow/react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { WorkflowFlowNode } from '../../model/graph-adapter';
import { WorkflowNodeHandles } from './workflow-node-handles';

const familyIcons = {
  trigger: PlayIcon,
  action: RadioTowerIcon,
  logic: GitBranchIcon,
  transform: BracesIcon,
  output: CheckCircle2Icon,
  unknown: BoxIcon,
} satisfies Record<
  WorkflowFlowNode['data']['family'],
  ComponentType<LucideProps>
>;

export function WorkflowNodeCard({
  data,
  selected,
}: NodeProps<WorkflowFlowNode>) {
  const Icon = familyIcons[data.family];
  const configured = data.configurationCount + data.connectionCount;
  return (
    <article
      data-selected={selected}
      className={cn(
        'relative isolate w-60 overflow-visible rounded-lg border border-white/10 border-t-white/15 border-l-white/15 bg-[linear-gradient(135deg,rgb(255_255_255/5%)_0%,rgb(255_255_255/1.5%)_100%),var(--card)] text-card-foreground shadow-[0_18px_48px_rgb(0_0_0/28%)] backdrop-blur-xl transition-[border-color,box-shadow,background] motion-reduce:transition-none',
        'before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:bg-[linear-gradient(rgb(255_255_255/3%)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/3%)_1px,transparent_1px)] before:bg-[size:8px_8px] before:opacity-75',
        selected &&
          'border-primary/45 bg-[linear-gradient(135deg,rgb(0_229_255/8%)_0%,rgb(255_255_255/2%)_100%),var(--card)] shadow-[0_0_22px_rgb(0_229_255/16%),inset_0_0_12px_rgb(0_229_255/5%),0_18px_48px_rgb(0_0_0/32%)]',
        selected &&
          'after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[inherit] after:border after:border-transparent after:bg-[linear-gradient(90deg,transparent,rgb(0_229_255),transparent)_border-box] after:[animation:workflow-node-scan_3s_linear_infinite] after:[mask-composite:exclude] after:[mask:linear-gradient(#fff_0_0)_padding-box,linear-gradient(#fff_0_0)] motion-reduce:after:animate-none',
      )}
    >
      <WorkflowNodeHandles
        inputPorts={data.inputPorts}
        outputPorts={data.outputPorts}
      />
      <div className="relative z-10 p-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="relative size-2 shrink-0 rounded-full bg-primary after:absolute after:inset-[-0.25rem] after:rounded-full after:bg-primary/60 after:blur-[6px]" />
            <span className="truncate font-heading text-[0.66rem] font-semibold tracking-[0.16em] text-primary uppercase">
              {data.unsupported ? 'unsupported' : data.family}
            </span>
          </div>
          <Icon
            aria-hidden="true"
            className="size-4 shrink-0 text-primary/80"
          />
        </div>

        <div className="mt-3 flex items-start justify-between gap-3 border-t border-white/6 pt-3">
          <div className="min-w-0">
            <h2 className="truncate font-heading text-sm font-semibold">
              {data.label}
            </h2>
            <p className="mt-1 truncate font-mono text-[0.68rem] text-muted-foreground">
              {data.definitionKey}@{data.definitionVersion}
            </p>
          </div>
          {data.unsupported ? (
            <Badge variant="secondary">Preserved</Badge>
          ) : null}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-white/6 bg-black/25 px-2.5 py-2 font-mono text-[0.64rem] text-muted-foreground">
          <span>{String(configured)} configured</span>
          <span>
            {String(data.inputPorts.length)} in ·{' '}
            {String(data.outputPorts.length)} out
          </span>
        </div>
      </div>
    </article>
  );
}
