import { cn } from '@/lib/utils';

// Small decorative thread drawings for system states. Motion stops under
// reduced motion; the surrounding copy always carries the meaning.

type IllustrationProps = Readonly<{ className?: string }>;

const frame = 'h-24 w-full max-w-56 overflow-visible';

/** A thread that drifts off into nothing: something isn't here. */
export function LooseThread({ className }: IllustrationProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 210 90"
      className={cn(frame, className)}
    >
      <defs>
        <linearGradient id="loose-thread-fade" x1="0" x2="1">
          <stop offset="0" stopColor="var(--muted-foreground)" />
          <stop
            offset="1"
            stopColor="var(--muted-foreground)"
            stopOpacity="0"
          />
        </linearGradient>
      </defs>
      <circle cx="20" cy="45" r="4" fill="var(--success)" />
      <path
        d="M24 45 C 70 45, 80 20, 120 32 S 180 72, 214 52"
        fill="none"
        stroke="url(#loose-thread-fade)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="6 10"
        className="motion-safe:animate-[thread-drift_2.4s_linear_infinite]"
      />
    </svg>
  );
}

/** A thread stopped by a bar: not allowed for this role. */
export function BarredThread({ className }: IllustrationProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 210 90"
      className={cn(frame, className)}
    >
      <path
        d="M20 45h92"
        stroke="var(--primary)"
        strokeOpacity="0.3"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M20 45h92"
        stroke="var(--accent-foreground)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray="6 26"
        className="motion-safe:animate-[thread-drift_2.4s_linear_infinite]"
      />
      <path
        d="M122 22v46"
        stroke="var(--destructive)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <rect
        x="140"
        y="36"
        width="20"
        height="16"
        rx="3"
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth="1.6"
      />
      <path
        d="M144 36v-4a6 6 0 0 1 12 0v4"
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth="1.6"
      />
    </svg>
  );
}
