import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { providerName, type SocialProvider } from './social-provider';

type SocialProviderButtonProps = Readonly<
  Omit<ComponentProps<typeof Button>, 'children'> & {
    provider: SocialProvider;
    action?: 'Continue with' | 'Link';
  }
>;

/** A compact provider choice: the mark and the name, "Continue with …". */
export function SocialProviderButton({
  provider,
  action = 'Continue with',
  className,
  ...props
}: SocialProviderButtonProps) {
  return (
    <Button
      type="button"
      aria-label={`${action} ${providerName(provider)}`}
      variant="outline"
      className={cn(
        'h-9.5 w-full gap-2.5 border-white/10 bg-white/[0.035] text-[0.82rem] text-foreground hover:border-primary/35 hover:bg-primary/[0.07]',
        className,
      )}
      {...props}
    >
      <ProviderMark provider={provider} />
      <span>{providerName(provider)}</span>
    </Button>
  );
}

export function ProviderMark({
  provider,
}: Readonly<{ provider: SocialProvider }>) {
  if (provider === 'google') {
    return (
      <svg
        aria-hidden="true"
        className="relative size-[1.125rem]"
        viewBox="0 0 24 24"
      >
        <path
          fill="#4285f4"
          d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z"
        />
        <path
          fill="#34a853"
          d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.05v2.62A10 10 0 0 0 12 22Z"
        />
        <path
          fill="#fbbc05"
          d="M6.39 13.86A6.02 6.02 0 0 1 6.08 12c0-.65.11-1.28.31-1.86V7.52H3.05A10 10 0 0 0 2 12c0 1.61.38 3.14 1.05 4.48l3.34-2.62Z"
        />
        <path
          fill="#ea4335"
          d="M12 6.01c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.95 5.52l3.34 2.62C7.18 7.77 9.39 6.01 12 6.01Z"
        />
      </svg>
    );
  }

  if (provider === 'microsoft') {
    return (
      <svg aria-hidden="true" className="relative size-4" viewBox="0 0 18 18">
        <path fill="#f35325" d="M0 0h8.5v8.5H0z" />
        <path fill="#81bc06" d="M9.5 0H18v8.5H9.5z" />
        <path fill="#05a6f0" d="M0 9.5h8.5V18H0z" />
        <path fill="#ffba08" d="M9.5 9.5H18V18H9.5z" />
      </svg>
    );
  }

  if (provider === 'github') {
    return (
      <svg
        aria-hidden="true"
        className="relative size-[1.15rem] text-foreground"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.58 9.58 0 0 1 12 6.82c.85 0 1.69.11 2.48.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.86v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className="relative size-[1.2rem] text-foreground"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.26.07 2.14.69 2.88.74 1.11-.23 2.17-.89 3.35-.8 1.42.12 2.49.67 3.2 1.7-2.93 1.76-2.23 5.62.45 6.7-.54 1.43-1.24 2.85-1.88 4.63ZM12.03 7.23C11.88 5.1 13.62 3.34 15.61 3.17c.27 2.46-2.23 4.3-3.58 4.06Z" />
    </svg>
  );
}
