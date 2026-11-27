import {
  StatusMark,
  type StatusTone,
} from '@/components/patterns/status/status-mark';
import { cn } from '@/lib/class-names';
import { statusToneText } from '@/components/patterns/status/status-tone';
import { toneLineStyle } from '../model/presentation/tone-styles';

/**
 * A run's duration as a thread: its length is the run's share of the longest
 * visible run (log scale). Running threads carry a light at their tip,
 * finished ones end in a knot, failed ones at a cross. Decorative: the row states
 * the duration in words.
 */
export function RunDurationBar({
  share,
  tone,
  className,
}: Readonly<{ share: number; tone: StatusTone; className?: string }>) {
  const style = toneLineStyle(tone);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative block h-3 w-full',
        statusToneText[tone],
        className,
      )}
    >
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-surface-ink/6" />
      <span
        className="absolute top-1/2 left-0 -translate-y-1/2"
        style={{ width: `${String(Math.round(share * 1000) / 10)}%` }}
      >
        <span
          className={cn(
            'block w-full',
            style === 'solid' && 'h-0.5 rounded-full bg-current opacity-80',
            style === 'dashed' &&
              'border-t border-dashed border-current opacity-75',
            style === 'dotted' &&
              'border-t border-dotted border-current opacity-70',
            tone === 'live' &&
              'bg-linear-to-r from-primary/25 to-accent-foreground opacity-100 shadow-live',
          )}
        />
        <StatusMark
          display="mark"
          tone={tone}
          className="absolute top-1/2 right-0 translate-x-2 -translate-y-1/2"
        />
      </span>
    </span>
  );
}
