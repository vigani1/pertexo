import { createElement } from 'react';
import { KeyRoundIcon } from 'lucide-react';
import { cn } from '@/lib/class-names';
import {
  catalogIcon,
  useConnectionDefinitions,
} from '@/features/catalog/public';
import {
  connectionDefinition,
  type ConnectionChoice,
} from '../model/connection-providers';

/** The provider's small square tile: the same mark in rows, sockets and lenses. */
export function ProviderTile({
  provider,
  size = 'md',
  className,
}: Readonly<{
  provider: ConnectionChoice;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}>) {
  const definitions = useConnectionDefinitions();
  const icon =
    catalogIcon(connectionDefinition(definitions, provider)?.icon) ??
    KeyRoundIcon;
  return (
    <span
      aria-hidden="true"
      data-slot="provider-tile"
      className={cn(
        'grid shrink-0 place-items-center rounded-md border border-border-strong bg-raised text-accent-foreground',
        size === 'sm' && 'size-7 [&_svg]:size-3.5',
        size === 'md' && 'size-8.5 [&_svg]:size-4',
        size === 'lg' && 'size-10 rounded-lg [&_svg]:size-5',
        className,
      )}
    >
      {createElement(icon)}
    </span>
  );
}
