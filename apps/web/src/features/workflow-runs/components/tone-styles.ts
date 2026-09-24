import type { StatusTone } from '@/components/ui/status';

// The status primitive's colour per tone, for run visuals drawn outside a
// `Status` (thread bars, thread segments, graph edges). Same tokens.
export const toneTextClass: Readonly<Record<StatusTone, string>> = {
  live: 'text-primary',
  queued: 'text-secondary',
  waiting: 'text-secondary',
  success: 'text-success',
  failure: 'text-destructive',
  timeout: 'text-destructive',
  attention: 'text-warning',
  canceled: 'text-subtle-foreground',
  skipped: 'text-subtle-foreground',
  neutral: 'text-muted-foreground',
};

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
