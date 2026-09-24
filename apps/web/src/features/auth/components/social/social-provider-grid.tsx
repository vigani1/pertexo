import type { ReactNode } from 'react';
import { SocialProviderButton } from './social-provider-button';
import type { SocialProvider } from './social-provider';

/** Provider choices in two columns; an odd last one takes the full row. */
export function SocialProviderGrid({
  providers,
  label,
  disabled,
  onSelect,
}: Readonly<{
  providers: readonly SocialProvider[];
  label: string;
  disabled: boolean;
  onSelect: (provider: SocialProvider) => void;
}>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-2 gap-2 [&>:last-child:nth-child(odd)]:col-span-2"
    >
      {providers.map((provider) => (
        <SocialProviderButton
          key={provider}
          provider={provider}
          disabled={disabled}
          onClick={() => {
            onSelect(provider);
          }}
        />
      ))}
    </div>
  );
}

/** "or with email": a quiet break between providers and the form. */
export function OrDivider({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="my-4 flex items-center gap-3 text-[0.75rem] text-subtle-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
      {children}
    </div>
  );
}
