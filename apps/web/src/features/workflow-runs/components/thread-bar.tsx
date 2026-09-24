import type { StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { statusToneText } from '@/components/ui/status-tone';
import { toneLineStyle } from './tone-styles';

/**
 * A run's duration as a thread: its length is the run's share of the longest
 * visible run (log scale). Running threads carry a light at their tip,
 * finished ones end in a knot, failed ones fray. Decorative: the row states
 * the duration in words.
 */
export function ThreadBar({
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
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/6" />
      <span
        className="absolute top-1/2 left-0 -translate-y-1/2"
        style={{ width: `${String(Math.round(share * 1000) / 10)}%` }}
      >
        <span
          className={cn(
            'block w-full',
            style === 'solid' && 'h-0.5 rounded-full bg-current opacity-80',
            style === 'dashed' &&
              'border-t-2 border-dashed border-current opacity-75',
            style === 'dotted' &&
              'border-t-2 border-dotted border-current opacity-70',
            tone === 'live' &&
              'bg-linear-to-r from-primary/25 to-accent-foreground opacity-100 shadow-[0_0_8px_var(--primary)]',
          )}
        />
        <ThreadEnd tone={tone} />
      </span>
    </span>
  );
}

function ThreadEnd({ tone }: Readonly<{ tone: StatusTone }>) {
  const base = 'absolute top-1/2 -right-1 -translate-y-1/2';
  switch (tone) {
    case 'live':
      return (
        <span
          className={cn(
            base,
            'size-2 rounded-full bg-accent-foreground shadow-[0_0_10px_var(--primary)] motion-safe:animate-tip',
          )}
        />
      );
    case 'success':
      return <span className={cn(base, 'size-1.5 rounded-full bg-current')} />;
    case 'failure':
    case 'timeout':
      return (
        <svg
          viewBox="0 0 10 10"
          className={cn(base, '-right-2.5 size-2.5 overflow-visible')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        >
          {tone === 'failure' ? (
            <path d="M0 5l8-3.5M0 5h9M0 5l8 3.5" />
          ) : (
            <path d="M3 1v8" />
          )}
        </svg>
      );
    default:
      return null;
  }
}
