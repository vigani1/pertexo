import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon, CopyXIcon } from 'lucide-react';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { useNotifications } from './use-notifications';
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
 * it, so rows stay distinguishable. A copy confirms in place; a blocked one
 * also says what to do, since a red icon alone doesn't.
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
  const notifications = useNotifications();

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
      if (!copied)
        notifications.error({
          title: 'Couldn’t copy',
          description:
            'This browser blocked the clipboard. Select the text and copy it yourself.',
        });
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
        // A little room inside, so the focus ring doesn't touch the text.
        'group/copy -mx-1 inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-sm px-1 font-mono text-xs pointer-coarse:min-h-10 text-subtle-foreground outline-none hover:text-foreground focus-ring [&_svg]:size-3 [&_svg]:shrink-0',
        className,
      )}
      onClick={copy}
    >
      <span className="truncate">{display}</span>
      <OutcomeIcon outcome={outcome} />
    </button>
  );
}
