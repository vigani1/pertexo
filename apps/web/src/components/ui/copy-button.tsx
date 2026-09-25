import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon, CopyXIcon } from 'lucide-react';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { Button } from './button';

const FEEDBACK_MS = 1_600;

type Outcome = 'copied' | 'blocked' | undefined;

const OUTCOME_LABEL: Readonly<Record<Exclude<Outcome, undefined>, string>> = {
  copied: 'Copied',
  blocked: 'Couldn’t copy. Select the text instead.',
};

function OutcomeIcon({ outcome }: Readonly<{ outcome: Outcome }>) {
  if (outcome === 'copied')
    return <CheckIcon aria-hidden="true" className="text-success" />;
  if (outcome === 'blocked')
    return <CopyXIcon aria-hidden="true" className="text-destructive" />;
  return <CopyIcon aria-hidden="true" />;
}

/**
 * The one way to copy a value. `label` names the action ("Copy run ID"); with
 * `display` the button shows that text (a short ID) in mono and its name adds
 * it, so rows stay distinguishable. It confirms in place — "Copied", or that
 * the browser blocked it — and never needs a toast.
 */
export function CopyButton({
  value,
  label,
  display,
  className,
}: Readonly<{
  value: string;
  label: string;
  display?: string;
  className?: string;
}>) {
  const [outcome, setOutcome] = useState<Outcome>();

  useEffect(() => {
    if (outcome === undefined) return;
    const timer = window.setTimeout(() => {
      setOutcome(undefined);
    }, FEEDBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [outcome]);

  const name =
    outcome === undefined
      ? [label, display].filter(Boolean).join(' ')
      : OUTCOME_LABEL[outcome];
  const copy = () => {
    void copyText(value).then((copied) => {
      setOutcome(copied ? 'copied' : 'blocked');
    });
  };

  if (display === undefined)
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={name}
        title={outcome === undefined ? label : name}
        className={className}
        onClick={copy}
      >
        <OutcomeIcon outcome={outcome} />
      </Button>
    );
  return (
    <button
      type="button"
      aria-label={name}
      title={outcome === undefined ? label : name}
      className={cn(
        'group/copy inline-flex min-w-0 items-center gap-1.5 rounded-sm font-mono text-xs text-subtle-foreground outline-none hover:text-foreground focus-ring [&_svg]:size-3 [&_svg]:shrink-0',
        className,
      )}
      onClick={copy}
    >
      <span className="truncate">{display}</span>
      <OutcomeIcon outcome={outcome} />
    </button>
  );
}
