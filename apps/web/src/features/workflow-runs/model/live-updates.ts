import type { StatusTone } from '@/components/ui/status';

export type LiveConnectionStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'degraded'
  | 'rate-limited'
  | 'authentication-required'
  | 'access-denied'
  | 'unavailable'
  | 'failed'
  | 'stopped';

export type LiveUpdatesLook = Readonly<{
  tone: StatusTone;
  label: string;
  /** Updates stopped on their own; offer to try again. */
  paused: boolean;
}>;

/**
 * The run page's live indicator in words: Live updates, Reconnecting…, Updates
 * paused. A finished run needs no indicator at all.
 */
export function describeLiveUpdates(
  status: LiveConnectionStatus,
  runActive: boolean,
): LiveUpdatesLook | undefined {
  if (!runActive) return undefined;
  switch (status) {
    case 'connecting':
      return { tone: 'queued', label: 'Connecting…', paused: false };
    case 'live':
      // The connection, not the run: neutral, so a waiting run doesn't
      // wear the running glyph.
      return { tone: 'neutral', label: 'Live updates', paused: false };
    case 'reconnecting':
    case 'degraded':
    case 'rate-limited':
      return { tone: 'waiting', label: 'Reconnecting…', paused: false };
    case 'stopped':
      return undefined;
    default:
      return { tone: 'attention', label: 'Updates paused', paused: true };
  }
}
