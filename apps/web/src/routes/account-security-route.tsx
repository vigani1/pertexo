import {
  Link,
  useLoaderData,
  useRouteContext,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import { AccountSecurityPage } from '@/features/auth/account-security.public';
import { Wordmark } from '@/features/auth/auth-stage.public';

// Standalone account page: the target of sign-in method callbacks and the
// workspace picker's account menu, outside any workspace.
export function AccountSecurityRoute() {
  const { apiClient } = useRouteContext({ from: '/account/security' });
  const user = useLoaderData({ from: '/account/security' });
  const search = useSearch({ from: '/account/security' });
  return (
    <div className="relative isolate min-h-svh bg-background">
      <div className="ambient fixed -z-10" aria-hidden="true" />
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 pt-6 sm:px-8">
        <Wordmark className="text-[1.375rem]" />
        <Link
          to="/"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
          Back to Pertexo
        </Link>
      </header>
      <main id="main" className="px-4 pt-10 pb-20 sm:px-8">
        <AccountSecurityPage
          key={user.id}
          apiClient={apiClient}
          user={user}
          {...(search.linked ? { linkOutcome: 'returned' as const } : {})}
          {...(search.linkError ? { linkOutcome: 'failed' as const } : {})}
        />
      </main>
    </div>
  );
}
