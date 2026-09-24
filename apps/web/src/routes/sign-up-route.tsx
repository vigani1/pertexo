import { useRouteContext } from '@tanstack/react-router';
import { SignUpPage } from '@/features/auth/sign-up.public';

export function SignUpRoute() {
  const { apiClient } = useRouteContext({ from: '/sign-up' });
  return <SignUpPage apiClient={apiClient} />;
}
