import type { StatusTone } from '@/components/patterns/status/status-mark';

// Run visuals drawn outside a `Status` (thread segments, graph edges) use
// the status colours from `statusToneText`, plus these borders.
export const toneBorderClass: Readonly<Record<StatusTone, string>> = {
  live: 'border-primary/55',
  queued: 'border-secondary/35',
  waiting: 'border-secondary/45',
  success: 'border-success/35',
  failure: 'border-destructive/55',
  timeout: 'border-destructive/45',
  attention: 'border-warning/50',
  canceled: 'border-surface-ink/10',
  off: 'border-surface-ink/10',
  skipped: 'border-surface-ink/8',
  neutral: 'border-surface-ink/10',
};
