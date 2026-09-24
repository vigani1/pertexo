import type { StatusTone } from '@/components/ui/status';

// Run visuals drawn outside a `Status` (thread segments, graph edges) use
// the status colours from `statusToneText`, plus these borders and lines.
export const toneBorderClass: Readonly<Record<StatusTone, string>> = {
  live: 'border-primary/55',
  queued: 'border-secondary/35',
  waiting: 'border-secondary/45',
  success: 'border-success/35',
  failure: 'border-destructive/55',
  timeout: 'border-destructive/45',
  attention: 'border-warning/50',
  canceled: 'border-white/10',
  skipped: 'border-white/8',
  neutral: 'border-white/10',
};

/** How a thread is drawn for a tone: solid, dashed (waiting) or dotted. */
export function toneLineStyle(tone: StatusTone): 'solid' | 'dashed' | 'dotted' {
  if (tone === 'waiting' || tone === 'skipped') return 'dashed';
  if (tone === 'queued' || tone === 'attention') return 'dotted';
  return 'solid';
}
