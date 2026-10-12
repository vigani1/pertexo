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
  compactLabel,
  blockedReason,
  onClick,
}: Readonly<{
  label: string;
  compactLabel?: string;
  blockedReason: string | undefined;
  onClick: () => void;
}>) {
  const reasonId = useId();
  const content = (
    <>
      <ArrowUpFromLineIcon
        data-icon="inline-start"
        className="hidden sm:block"
      />
      {compactLabel === undefined ? (
        <span className="min-w-0 truncate">{label}</span>
      ) : (
        <>
          <span className="hidden min-w-0 truncate sm:inline">{label}</span>
          <span className="min-w-0 truncate sm:hidden" aria-hidden="true">
            {compactLabel}
          </span>
        </>
      )}
    </>
  );
  if (blockedReason === undefined)
    return (
      <Button
        type="button"
        size="sm"
        variant="primary"
        className="w-48 max-w-full max-sm:min-w-0 max-sm:flex-1"
        aria-label={label}
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
              className="w-48 max-w-full max-sm:min-w-0 max-sm:flex-1"
              aria-label={label}
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
