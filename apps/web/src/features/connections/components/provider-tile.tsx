import { GlobeIcon, HashIcon, MailIcon, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProviderKey } from '../model/connection-providers';

const ICONS: Readonly<Record<ProviderKey, LucideIcon>> = {
  slack: HashIcon,
  http: GlobeIcon,
  email: MailIcon,
};

/** The provider's small square tile: the same mark in rows, sockets and lenses. */
export function ProviderTile({
  provider,
  size = 'md',
  className,
}: Readonly<{
  provider: ProviderKey;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}>) {
  const Icon = ICONS[provider];
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
      <Icon />
    </span>
  );
}
