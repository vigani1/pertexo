import { StatusGlyph } from '@/components/ui/status';

export function MembershipThread({
  state,
}: Readonly<{ state: 'pending' | 'accepted' | 'removed' }>) {
  return (
    <div
      aria-hidden="true"
      className="mt-2 flex w-40 max-w-full items-center text-muted-foreground"
    >
      <svg
        viewBox="0 0 130 20"
        className="h-5 min-w-0 flex-1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path
          d={
            state === 'pending'
              ? 'M0 10C30 10 40 2 65 10S105 19 130 5'
              : 'M0 10H130'
          }
          strokeDasharray={state === 'pending' ? '3 4' : undefined}
        />
      </svg>
      {state === 'pending' ? (
        <span className="size-1 rounded-full bg-muted-foreground/40" />
      ) : (
        <StatusGlyph
          tone={state === 'accepted' ? 'success' : 'failure'}
          className={state === 'accepted' ? 'text-success' : 'text-destructive'}
        />
      )}
    </div>
  );
}
