import { useRouteContext } from '@tanstack/react-router';
import { PasswordRecoveryPage } from '@/features/auth/password-recovery.public';

export function PasswordRecoveryRoute() {
  const { apiClient } = useRouteContext({ from: '/forgot-password' });
  return <PasswordRecoveryPage apiClient={apiClient} />;
}
