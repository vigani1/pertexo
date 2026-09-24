import {
  BracesIcon,
  CalendarClockIcon,
  MousePointerClickIcon,
  RotateCcwIcon,
  WebhookIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { describeTrigger, type RunTriggerType } from '../model/run-status';

const triggerIcons: Readonly<Record<RunTriggerType, LucideIcon>> = {
  api: BracesIcon,
  manual: MousePointerClickIcon,
  replay: RotateCcwIcon,
  schedule: CalendarClockIcon,
  webhook: WebhookIcon,
};

/** How a run started, as an icon and a word. */
export function TriggerLabel({
  type,
  className,
}: Readonly<{ type: RunTriggerType; className?: string }>) {
  const Icon = triggerIcons[type];
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-muted-foreground',
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0 opacity-80" />
      <span className="truncate">{describeTrigger(type)}</span>
    </span>
  );
}
