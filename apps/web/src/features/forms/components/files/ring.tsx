import { cn } from '@/lib/utils';
import type { UploadPhase } from '../../model/uploads';

const CENTER = 14;
const RADIUS = 11;

function arc(from: number, to: number): string {
  const point = (degrees: number) => {
    const radians = ((degrees - 90) * Math.PI) / 180;
    return `${(CENTER + RADIUS * Math.cos(radians)).toFixed(2)} ${(CENTER + RADIUS * Math.sin(radians)).toFixed(2)}`;
  };
  return `M${point(from)}A${String(RADIUS)} ${String(RADIUS)} 0 0 1 ${point(to)}`;
}

// Three strands: checking the file, sending it, the server verifying it.
const STRANDS = [arc(6, 114), arc(126, 234), arc(246, 354)] as const;
const STEP: Readonly<Record<UploadPhase, number>> = {
  checking: 0,
  reserving: 0,
  sending: 1,
  verifying: 2,
  ready: 3,
  failed: 3,
};

/**
 * A file's thread wound into a ring: each finished step is spun, light runs
 * along the one in progress, and the ring closes into a knot with a tick.
 * It restates the row's words, so assistive technology skips it.
 */
export function UploadRing({ phase }: Readonly<{ phase: UploadPhase }>) {
  const step = STEP[phase];
  return (
    <svg
      viewBox="0 0 28 28"
      aria-hidden="true"
      data-phase={phase}
      className={cn(
        'size-7 shrink-0',
        phase === 'ready' && 'text-success',
        phase === 'failed' && 'text-destructive',
        phase !== 'ready' && phase !== 'failed' && 'text-primary',
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      {phase === 'failed' ? (
        <>
          <circle cx={CENTER} cy={CENTER} r={RADIUS} opacity={0.35} />
          <path d="M10.5 10.5l7 7M17.5 10.5l-7 7" />
        </>
      ) : null}
      {phase === 'ready' ? (
        <g className="origin-center motion-safe:animate-knot">
          <circle cx={CENTER} cy={CENTER} r={RADIUS} />
          <path d="M9.4 14.4l3.1 3.1 6.1-6.6" strokeWidth={2.2} />
        </g>
      ) : null}
      {step < 3
        ? STRANDS.map((strand, index) => (
            <g key={strand}>
              <path d={strand} opacity={index < step ? 1 : 0.18} />
              {index === step ? (
                <path
                  d={strand}
                  pathLength={26}
                  className="[stroke-dasharray:4_22] drop-shadow-[0_0_3px_currentColor] motion-loop:animate-thread-flow"
                />
              ) : null}
            </g>
          ))
        : null}
    </svg>
  );
}
