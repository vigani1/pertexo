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
  versionLabel,
  blockedReason,
  onClick,
}: Readonly<{
  versionLabel: string | undefined;
  blockedReason: string | undefined;
  onClick: () => void;
}>) {
  const reasonId = useId();
  const content = (
    <>
      <ArrowUpFromLineIcon data-icon="inline-start" />
      {versionLabel === undefined ? 'Publish' : `Publish ${versionLabel}`}
    </>
  );
  if (blockedReason === undefined)
    return (
      <Button type="button" size="sm" variant="primary" onClick={onClick}>
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
