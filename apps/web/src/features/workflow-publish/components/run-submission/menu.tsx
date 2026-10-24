import { ChevronDownIcon, PlayIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * Run ▾: start the published version straight away, or with an input. With
 * nothing published there is nothing to run, and the control says why.
 */
export function RunMenu({
  published,
  pending,
  acceptedRunPending,
  unresolvedRun = false,
  onRunNow,
  onRunWithInput,
  onOpenAcceptedRun,
}: Readonly<{
  published: boolean;
  pending: boolean;
  /** A run was accepted while the editor was paused; open it explicitly. */
  acceptedRunPending: boolean;
  unresolvedRun?: boolean;
  onRunNow: () => void;
  onRunWithInput: () => void;
  onOpenAcceptedRun: () => void;
}>) {
  if (unresolvedRun)
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        className="max-sm:w-20 max-sm:shrink-0"
        aria-label="Recover unconfirmed run"
        onClick={onRunWithInput}
      >
        <span className="hidden sm:inline">Recover unconfirmed run</span>
        <span className="min-w-0 truncate sm:hidden" aria-hidden="true">
          Recover
        </span>
      </Button>
    );
  if (acceptedRunPending)
    return (
      <Button
        type="button"
        size="sm"
        disabled={pending}
        className="max-sm:w-20 max-sm:shrink-0"
        aria-label={pending ? 'Verifying…' : 'Open accepted run'}
        onClick={onOpenAcceptedRun}
      >
        <span className="hidden sm:inline">
          {pending ? 'Verifying…' : 'Open accepted run'}
        </span>
        <span className="min-w-0 truncate sm:hidden" aria-hidden="true">
          {pending ? 'Verifying…' : 'Open run'}
        </span>
      </Button>
    );
  if (!published)
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled
              focusableWhenDisabled
              aria-label="Run (publish first)"
              className="max-sm:w-20 max-sm:shrink-0"
            />
          }
        >
          <PlayIcon data-icon="inline-start" className="hidden sm:block" />
          Run
        </TooltipTrigger>
        <TooltipContent>Publish first</TooltipContent>
      </Tooltip>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'max-sm:w-20 max-sm:shrink-0',
        )}
      >
        {pending ? (
          <LoadingOrb />
        ) : (
          <PlayIcon data-icon="inline-start" className="hidden sm:block" />
        )}
        <span className="min-w-0 truncate">
          {pending ? 'Starting…' : 'Run'}
        </span>
        {pending ? null : <ChevronDownIcon data-icon="inline-end" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onRunNow}>
            Run published version
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRunWithInput}>
            Run with input…
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
