import { CopyIcon } from 'lucide-react';
import { useNotifications } from '@/components/ui/use-notifications';
import { cn } from '@/lib/utils';

/**
 * A short identifier in mono that copies its full value. The full value is
 * never shown in lists; people paste it where they need it.
 */
export function CopyValueButton({
  value,
  display,
  label,
  className,
}: Readonly<{
  value: string;
  display: string;
  /** What is copied, e.g. "run ID". */
  label: string;
  className?: string;
}>) {
  const notifications = useNotifications();

  function copy() {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      notifications.error({
        title: `Couldn’t copy the ${label}`,
        description: 'This browser doesn’t allow copying from the page.',
      });
      return;
    }
    clipboard.writeText(value).then(
      () => {
        notifications.success({
          title: `${label.charAt(0).toUpperCase()}${label.slice(1)} copied`,
        });
      },
      () => {
        notifications.error({
          title: `Couldn’t copy the ${label}`,
          description: 'Allow clipboard access for this site and try again.',
        });
      },
    );
  }

  return (
    <button
      type="button"
      aria-label={`Copy ${label} ${display}`}
      title={`Copy ${label}`}
      className={cn(
        'group/copy inline-flex min-w-0 items-center gap-1.5 rounded-sm font-mono text-xs text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60',
        className,
      )}
      onClick={copy}
    >
      <span className="truncate">{display}</span>
      <CopyIcon
        aria-hidden="true"
        className="size-3 shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100"
      />
    </button>
  );
}
