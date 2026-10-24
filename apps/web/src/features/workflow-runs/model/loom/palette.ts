import type { StatusTone } from '@/components/ui/status';
import type { Rgb } from '@/lib/canvas-scene';

// Canvas 2D drawing for the Loom. Threads are drawn from real run times;
// running ones grow to "now" and feed light into the Core overlaid on the
// right. Pure drawing: the React component owns lifecycle and interaction.

const FALLBACK: Rgb = [127, 139, 142];

export const TOKENS = {
  ink: ['--surface-ink', [255, 255, 255]],
  live: ['--core-live', FALLBACK],
  tip: ['--core-glint', FALLBACK],
  success: ['--success', FALLBACK],
  failure: ['--destructive', FALLBACK],
  pending: ['--secondary', FALLBACK],
  warning: ['--warning', FALLBACK],
  muted: ['--subtle-foreground', FALLBACK],
  label: ['--muted-foreground', FALLBACK],
} as const;

export type Palette = Record<keyof typeof TOKENS, Rgb>;

export function toneColor(palette: Palette, tone: StatusTone): Rgb {
  switch (tone) {
    case 'live':
      return palette.live;
    case 'success':
      return palette.success;
    case 'failure':
    case 'timeout':
      return palette.failure;
    case 'queued':
    case 'waiting':
      return palette.pending;
    case 'attention':
      return palette.warning;
    case 'canceled':
    case 'neutral':
    case 'skipped':
    default:
      return palette.muted;
  }
}
