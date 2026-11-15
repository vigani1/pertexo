import { useRouteContext, useSearch } from '@tanstack/react-router';
import { allowlistedReturnPath } from '@/features/auth/auth-routing.public';
import { SignUpPage } from '@/features/auth/pages/sign-up';

export function SignUpRoute() {
  const { apiClient } = useRouteContext({ from: '/_stage/sign-up' });
  const search = useSearch({ from: '/_stage/sign-up' });
  return (
    <SignUpPage
      apiClient={apiClient}
      returnTo={allowlistedReturnPath(search.returnTo)}
    />
  );
}
