import { PlusIcon } from 'lucide-react';
import { cn } from '@/lib/class-names';
import {
  isConnectionChoice,
  type ConnectionChoice,
} from '../model/connection-providers';
import { useConnectionDefinitions } from '@/features/catalog/public';
import { ProviderTile } from './provider-tile';

/**
 * One socket per provider Pertexo can plug into. Always visible to people who
 * manage connections, it doubles as the empty state's call to action. On the
 * page they sit in a row; inside a lens they stack, so each keeps its words.
 */
export function ProviderSockets({
  layout = 'row',
  onConnect,
}: Readonly<{
  layout?: 'row' | 'stack';
  onConnect: (provider: ConnectionChoice) => void;
}>) {
  const choices = useConnectionDefinitions()
    .flatMap(({ presentation }) =>
      presentation.pickerOrder !== undefined &&
      isConnectionChoice(presentation.choice)
        ? [
            {
              ...presentation,
              provider: presentation.choice,
              order: presentation.pickerOrder,
            },
          ]
        : [],
    )
    .sort((left, right) => left.order - right.order);
  return (
    <ul
      aria-label="Services you can connect"
      className={cn('grid gap-3', layout === 'row' && 'lg:grid-cols-3')}
    >
      {choices.map(({ provider, name, purpose }) => (
        <li key={provider}>
          <button
            type="button"
            aria-label={`Connect ${name}`}
            className="group/socket flex w-full items-center gap-3 rounded-lg border border-border bg-linear-135 from-select to-transparent p-3.5 text-left transition-colors outline-none hover:border-primary/35 focus-ring"
            onClick={() => {
              onConnect(provider);
            }}
          >
            <ProviderTile provider={provider} size="lg" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{name}</span>
              <span className="block text-xs text-pretty text-muted-foreground">
                {purpose}
              </span>
            </span>
            <PlusIcon
              aria-hidden="true"
              className="size-4 text-subtle-foreground transition-colors group-hover/socket:text-action"
            />
          </button>
        </li>
      ))}
    </ul>
  );
}
