import { CoreOrb, type CoreOrbState } from '@/components/patterns/core-orb';
import { cn } from '@/lib/utils';
import type { TestPhase } from '../../model/connection-health';
import type { ProviderKey } from '../../model/connection-providers';
import { ProviderTile } from '../provider-tile';

const ORB_STATE: Readonly<Record<TestPhase, CoreOrbState>> = {
  idle: 'idle',
  running: 'live',
  ok: 'succeeded',
  failed: 'failed',
  unsure: 'waiting',
};

// One gentle curve from the Core (left) to the provider tile (right).
const THREAD = 'M6 30 C 70 30, 90 12, 150 22 S 230 30, 254 30';
const FRAYED = 'M6 30 C 70 30, 90 12, 150 22';

function ThreadStroke({ phase }: Readonly<{ phase: TestPhase }>) {
  switch (phase) {
    case 'idle':
      return (
        <path
          d={THREAD}
          pathLength={100}
          strokeDasharray="1.5 3"
          className="stroke-subtle-foreground/50"
        />
      );
    case 'running':
      return (
        <>
          <path d={THREAD} className="stroke-primary/25" />
          <path
            d={THREAD}
            pathLength={100}
            strokeDasharray="8 24"
            className="stroke-accent-foreground drop-shadow-[0_0_4px_var(--primary)] motion-safe:animate-[thread-drift_1.1s_linear_infinite]"
          />
        </>
      );
    case 'ok':
      return (
        <>
          <path d={THREAD} className="stroke-success" />
          <circle
            cx={254}
            cy={30}
            r={5}
            className="origin-[254px_30px] fill-success stroke-none motion-safe:animate-knot"
          />
        </>
      );
    case 'failed':
      return (
        <>
          <path d={FRAYED} className="stroke-destructive" />
          <g className="origin-[150px_22px] stroke-destructive motion-safe:animate-fray">
            <path d="M150 22l16-9" />
            <path d="M150 22h18" />
            <path d="M150 22l16 9" />
          </g>
        </>
      );
    case 'unsure':
      return (
        <>
          <path d={FRAYED} className="stroke-muted-foreground" />
          <path
            d="M156 23 C 190 28, 230 30, 254 30"
            pathLength={100}
            strokeDasharray="1 6"
            className="stroke-warning motion-safe:animate-blink"
          />
        </>
      );
  }
}

/**
 * The connection test drawn as a thread from Pertexo's Core to the provider:
 * light travels while the test runs, then it ties a knot or frays.
 */
export function TestThread({
  provider,
  phase,
  className,
}: Readonly<{
  provider: ProviderKey;
  phase: TestPhase;
  className?: string;
}>) {
  return (
    <div
      aria-hidden="true"
      data-slot="test-thread"
      data-phase={phase}
      className={cn(
        'relative grid h-28 grid-cols-[3.5rem_minmax(0,1fr)_2.5rem] items-center gap-1 rounded-lg border border-border bg-black/25 px-4',
        phase === 'running' && 'live-edge',
        className,
      )}
    >
      <CoreOrb state={ORB_STATE[phase]} energy={0.6} className="size-14" />
      <svg
        viewBox="0 0 260 44"
        className="h-11 w-full overflow-visible"
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
      >
        <ThreadStroke phase={phase} />
      </svg>
      <ProviderTile provider={provider} size="lg" />
    </div>
  );
}
