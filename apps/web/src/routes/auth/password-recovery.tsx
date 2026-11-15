import { useRouteContext } from '@tanstack/react-router';
import { PasswordRecoveryPage } from '@/features/auth/pages/password-recovery';

export function PasswordRecoveryRoute() {
  const { apiClient } = useRouteContext({ from: '/_stage/forgot-password' });
  return <PasswordRecoveryPage apiClient={apiClient} />;
}
