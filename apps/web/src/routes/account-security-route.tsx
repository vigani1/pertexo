import {
  Link,
  useLoaderData,
  useRouteContext,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import { AccountSecurityPage } from '@/features/auth/account-security.public';

// Standalone account page for sign-in method callbacks and the picker.
export function AccountSecurityRoute() {
  const { apiClient } = useRouteContext({ from: '/account/security' });
  const user = useLoaderData({ from: '/account/security' });
  const search = useSearch({ from: '/account/security' });
  return (
    <div className="relative min-h-svh bg-background">
      <div className="ambient fixed" aria-hidden="true" />
      <main
        id="main"
        className="relative mx-auto w-full max-w-5xl px-4 py-6 sm:px-6"
      >
        <Link
          to="/"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
          Back to Pertexo
        </Link>
        <div className="mt-6">
          <AccountSecurityPage
            key={user.id}
            apiClient={apiClient}
            user={user}
            {...(search.linked ? { linkOutcome: 'returned' as const } : {})}
            {...(search.linkError ? { linkOutcome: 'failed' as const } : {})}
          />
        </div>
      </main>
    </div>
  );
}
