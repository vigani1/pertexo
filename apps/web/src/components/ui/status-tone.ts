import type { StatusTone } from './status';

/** The one colour per status tone, for glyphs and threads drawn outside `Status`. */
export const statusToneText: Readonly<Record<StatusTone, string>> = {
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
