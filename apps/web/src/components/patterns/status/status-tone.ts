import type { StatusTone } from './status-mark';

/** The one colour per status tone, for glyphs and threads drawn outside `Status`. */
export const statusToneText: Readonly<Record<StatusTone, string>> = {
  live: 'text-glint',
  queued: 'text-subtle-foreground',
  waiting: 'text-waiting',
  success: 'text-foreground',
  failure: 'text-destructive',
  timeout: 'text-destructive',
  attention: 'text-warn',
  canceled: 'text-subtle-foreground',
  skipped: 'text-subtle-foreground',
  off: 'text-subtle-foreground',
  neutral: 'text-muted-foreground',
};
