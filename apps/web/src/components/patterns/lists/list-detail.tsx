import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ChevronLeftIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/class-names';

/**
 * A list beside the detail of its chosen item. Below about 900 px the two
 * take turns: the list, then the detail with a back link to the list.
 * `showing` says which one a narrow screen shows; wide screens show both.
 */
export function ListDetail({
  list,
  detail,
  showing,
  backLabel,
  onBack,
  backDisabled = false,
  className,
}: Readonly<{
  list: ReactNode;
  detail: ReactNode;
  showing: 'list' | 'detail';
  /** The back link's words on a narrow screen, such as “All versions”. */
  backLabel: string;
  onBack: () => void;
  backDisabled?: boolean;
  className?: string;
}>) {
  const listPane = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const selectedControl = useRef<HTMLElement>(null);
  const previous = useRef(showing);
  useLayoutEffect(() => {
    if (previous.current === showing) return;
    previous.current = showing;
    if (showing === 'detail') {
      if (back.current?.getClientRects().length) back.current.focus();
    } else if (selectedControl.current?.isConnected) {
      selectedControl.current.focus();
    } else {
      listPane.current?.focus();
    }
  }, [showing]);
  return (
    <div
      className={cn(
        'grid min-w-0 items-start gap-10 min-[56.25rem]:grid-cols-[18.75rem_minmax(0,1fr)] min-[56.25rem]:gap-14',
        className,
      )}
    >
      <div
        ref={listPane}
        tabIndex={-1}
        onClickCapture={(event) => {
          if (event.target instanceof Element)
            selectedControl.current =
              event.target.closest<HTMLElement>('button, a[href]');
        }}
        className={cn(
          'min-w-0',
          showing === 'detail' && 'max-[56.25rem]:hidden',
        )}
      >
        {list}
      </div>
      <div
        className={cn(
          'flex min-w-0 flex-col',
          showing === 'list' && 'max-[56.25rem]:hidden',
        )}
      >
        <Button
          ref={back}
          disabled={backDisabled}
          type="button"
          variant="ghost"
          size="sm"
          className="mb-4 self-start min-[56.25rem]:hidden"
          onClick={onBack}
        >
          <ChevronLeftIcon aria-hidden="true" data-icon="inline-start" />
          {backLabel}
        </Button>
        {detail}
      </div>
    </div>
  );
}
