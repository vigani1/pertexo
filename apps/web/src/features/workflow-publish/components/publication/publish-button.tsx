import { ArrowUpFromLineIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * Publish vN, the one filled action on the screen. When publishing can't
 * start yet it stays in place, disabled but focusable, and says why both in
 * a tooltip and in its accessible description.
 */
export function PublishButton({
  label,
  blockedReason,
  onClick,
}: Readonly<{
  label: string;
  blockedReason: string | undefined;
  onClick: () => void;
}>) {
  const reasonId = useId();
  const content = (
    <>
      <ArrowUpFromLineIcon data-icon="inline-start" />
      {label}
    </>
  );
  if (blockedReason === undefined)
    return (
      <Button
        type="button"
        size="sm"
        variant="primary"
        className="w-48 max-w-full"
        onClick={onClick}
      >
        {content}
      </Button>
    );
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="w-48 max-w-full"
              disabled
              focusableWhenDisabled
              aria-describedby={reasonId}
            />
          }
        >
          {content}
        </TooltipTrigger>
        <TooltipContent>{blockedReason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {blockedReason}
      </span>
    </>
  );
}
