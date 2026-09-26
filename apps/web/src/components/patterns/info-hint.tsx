import { InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * A small (i) beside a term that explains it. A popover rather than a
 * tooltip, so a tap on a phone and the keyboard open it too.
 */
export function InfoHint({
  title,
  children,
  className,
}: Readonly<{ title: string; children: ReactNode; className?: string }>) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`About ${title}`}
            className={cn(
              'text-subtle-foreground hover:text-foreground',
              className,
            )}
          />
        }
      >
        <InfoIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <PopoverTitle className="text-sm">{title}</PopoverTitle>
        <div className="mt-1.5 flex flex-col gap-2 text-[0.82rem] leading-relaxed text-muted-foreground">
          {children}
        </div>
      </PopoverContent>
    </Popover>
  );
}
