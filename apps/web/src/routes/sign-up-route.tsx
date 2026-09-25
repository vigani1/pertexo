import { useRouteContext, useSearch } from '@tanstack/react-router';
import { returnPathFrom } from '@/features/auth/return-path.public';
import { SignUpPage } from '@/features/auth/sign-up.public';

export function SignUpRoute() {
  const { apiClient } = useRouteContext({ from: '/sign-up' });
  const search = useSearch({ from: '/sign-up' });
  return (
    <SignUpPage
      apiClient={apiClient}
      returnTo={returnPathFrom(search.returnTo)}
    />
  );
}
