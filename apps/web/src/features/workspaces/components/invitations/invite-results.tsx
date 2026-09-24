import { Button } from '@/components/ui/button';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Status, type StatusTone } from '@/components/ui/status';

export type InviteDelivery =
  'waiting' | 'sending' | 'sent' | 'failed' | 'unsure' | 'skipped';

export type InviteRow = Readonly<{
  email: string;
  delivery: InviteDelivery;
  message?: string;
}>;

const WORDS: Readonly<
  Record<
    Exclude<InviteDelivery, 'sending'>,
    Readonly<{ tone: StatusTone; label: string }>
  >
> = {
  waiting: { tone: 'queued', label: 'Waiting' },
  sent: { tone: 'success', label: 'Sent' },
  failed: { tone: 'failure', label: 'Not sent' },
  unsure: { tone: 'attention', label: 'Not confirmed' },
  skipped: { tone: 'canceled', label: 'Skipped' },
};

/** One line per address as the invitations go out, one by one. */
export function InviteResults({
  rows,
  busy,
  onRetry,
  onSkip,
}: Readonly<{
  rows: readonly InviteRow[];
  busy: boolean;
  onRetry: () => void;
  onSkip: () => void;
}>) {
  return (
    <ul
      aria-label="Invitation results"
      className="flex flex-col"
      aria-live="polite"
    >
      {rows.map((row) => (
        <li
          key={row.email}
          className="flex flex-col gap-1.5 border-t border-border py-2.5 first:border-t-0"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm">{row.email}</span>
            {row.delivery === 'sending' ? (
              <span className="inline-flex items-center gap-1.5 text-[0.8rem] font-semibold text-primary">
                <LoadingOrb />
                Sending
              </span>
            ) : (
              <Status tone={WORDS[row.delivery].tone}>
                {WORDS[row.delivery].label}
              </Status>
            )}
          </div>
          {row.message === undefined ? null : (
            <p
              role={
                row.delivery === 'unsure' || row.delivery === 'failed'
                  ? 'alert'
                  : undefined
              }
              className="text-xs text-muted-foreground"
            >
              {row.message}
            </p>
          )}
          {row.delivery === 'unsure' ? (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="default"
                disabled={busy}
                onClick={onRetry}
              >
                Try again
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={onSkip}
              >
                Skip
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
