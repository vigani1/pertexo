import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from './button';

const COPIED_FEEDBACK_MS = 1_600;

/**
 * Copies a value to the clipboard and confirms in place. `label` names what
 * is copied for assistive technology, e.g. "Copy workspace ID".
 */
export function CopyButton({
  value,
  label,
  className,
}: Readonly<{ value: string; label: string; className?: string }>) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_FEEDBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? 'Copied' : label}
      className={className}
      onClick={() => {
        // The clipboard is missing outside secure contexts; stay quiet there.
        void Promise.resolve()
          .then(() => navigator.clipboard.writeText(value))
          .then(() => {
            setCopied(true);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="text-success" />
      ) : (
        <CopyIcon aria-hidden="true" />
      )}
    </Button>
  );
}
